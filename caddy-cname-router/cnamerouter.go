// Package cnamerouter is a Caddy plugin for multi-tenant custom domain routing.
//
// When a request arrives for an arbitrary domain (e.g. customer.com), the plugin:
//  1. Resolves the CNAME: customer.com → bigcorp-dev.botcms.site
//  2. Parses the subdomain: tenant=bigcorp, env=dev (TENANT_ID-ENV_ID convention)
//  3. Verifies the tenant exists via in-cluster DNS (headless service):
//     bigcorp-dev-hl.bigcorp.svc.cluster.local → [pod IPs]
//  4. Sticky sessions: reads lb_session cookie → routes to same pod.
//     First request picks a pod and sets the cookie.
//  5. Proxies, preserving the original Host header so dotCMS serves the right site.
//
// The same CNAME resolution logic gates on-demand TLS — no external ask service.
package cnamerouter

import (
	"context"
	"fmt"
	"hash/fnv"
	"math/rand"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/caddy/v2/caddyconfig/httpcaddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"
)

func init() {
	caddy.RegisterModule(&CNAMERouter{})
	caddy.RegisterModule(&CNAMEPermission{})
	httpcaddyfile.RegisterHandlerDirective("cname_router", parseCNAMERouterCaddyfile)
}

func parseCNAMERouterCaddyfile(h httpcaddyfile.Helper) (caddyhttp.MiddlewareHandler, error) {
	r := new(CNAMERouter)
	return r, r.UnmarshalCaddyfile(h.Dispenser)
}

const (
	k8sSvcDomain      = "svc.cluster.local"
	defaultCookieName = "lb_session"
	headlessSuffix    = "-hl"
)

// shared holds config and CNAME cache used by both modules.
type shared struct {
	BaseDomain       string         `json:"base_domain"`
	Separator        string         `json:"separator,omitempty"`
	CacheTTL         caddy.Duration `json:"cache_ttl,omitempty"`
	NegativeCacheTTL caddy.Duration `json:"negative_cache_ttl,omitempty"`

	cache  sync.Map
	logger *zap.Logger
}

type cacheEntry struct {
	svcName   string
	namespace string
	err       error
	exp       time.Time
}

func (s *shared) provision(ctx caddy.Context) error {
	s.logger = ctx.Logger()
	if s.BaseDomain == "" {
		return fmt.Errorf("base_domain is required")
	}
	if s.Separator == "" {
		s.Separator = "-"
	}
	return nil
}

func (s *shared) positiveTTL() time.Duration {
	if s.CacheTTL > 0 {
		return time.Duration(s.CacheTTL)
	}
	return 5 * time.Minute
}

func (s *shared) negativeTTL() time.Duration {
	if s.NegativeCacheTTL > 0 {
		return time.Duration(s.NegativeCacheTTL)
	}
	return 30 * time.Second
}

func (s *shared) tenant(host string) (svcName, namespace string, err error) {
	if v, ok := s.cache.Load(host); ok {
		e := v.(*cacheEntry)
		if time.Now().Before(e.exp) {
			return e.svcName, e.namespace, e.err
		}
	}
	svc, ns, err := s.resolve(host)
	ttl := s.positiveTTL()
	if err != nil {
		ttl = s.negativeTTL()
	}
	s.cache.Store(host, &cacheEntry{svcName: svc, namespace: ns, err: err, exp: time.Now().Add(ttl)})
	return svc, ns, err
}

func (s *shared) resolve(host string) (svcName, namespace string, err error) {
	t, e, err := s.tenantFromHost(host)
	if err != nil {
		return "", "", err
	}
	svc := t + s.Separator + e
	ns := t
	hlFQDN := fmt.Sprintf("%s%s.%s.%s", svc, headlessSuffix, ns, k8sSvcDomain)
	addrs, err := net.LookupHost(hlFQDN)
	if err != nil || len(addrs) == 0 {
		return "", "", fmt.Errorf("headless service %q not found: %w", hlFQDN, err)
	}
	return svc, ns, nil
}

func (s *shared) tenantFromHost(host string) (tenantID, envID string, err error) {
	if strings.HasSuffix(host, "."+s.BaseDomain) {
		sub := strings.TrimSuffix(host, "."+s.BaseDomain)
		return s.parseSubdomain(sub)
	}
	cname, err := net.LookupCNAME(host)
	if err != nil {
		return "", "", fmt.Errorf("CNAME lookup %q: %w", host, err)
	}
	cname = strings.TrimSuffix(cname, ".")
	if cname == host {
		return "", "", fmt.Errorf("%q has no CNAME record", host)
	}
	if !strings.HasSuffix(cname, "."+s.BaseDomain) {
		return "", "", fmt.Errorf("CNAME %q does not point to %s", cname, s.BaseDomain)
	}
	sub := strings.TrimSuffix(cname, "."+s.BaseDomain)
	return s.parseSubdomain(sub)
}

func (s *shared) parseSubdomain(sub string) (string, string, error) {
	idx := strings.LastIndex(sub, s.Separator)
	if idx < 1 || idx == len(sub)-1 {
		return "", "", fmt.Errorf("subdomain %q does not match TENANT_ID%sENV_ID pattern", sub, s.Separator)
	}
	return sub[:idx], sub[idx+1:], nil
}

// unmarshalShared parses common directives for both modules.
func (s *shared) unmarshalShared(d *caddyfile.Dispenser) error {
	for d.NextBlock(0) {
		switch d.Val() {
		case "base_domain":
			if !d.NextArg() {
				return d.ArgErr()
			}
			s.BaseDomain = d.Val()
		case "separator":
			if !d.NextArg() {
				return d.ArgErr()
			}
			s.Separator = d.Val()
		case "cache_ttl":
			if !d.NextArg() {
				return d.ArgErr()
			}
			dur, err := time.ParseDuration(d.Val())
			if err != nil {
				return d.Errf("invalid cache_ttl: %v", err)
			}
			s.CacheTTL = caddy.Duration(dur)
		case "negative_cache_ttl":
			if !d.NextArg() {
				return d.ArgErr()
			}
			dur, err := time.ParseDuration(d.Val())
			if err != nil {
				return d.Errf("invalid negative_cache_ttl: %v", err)
			}
			s.NegativeCacheTTL = caddy.Duration(dur)
		default:
			return d.Errf("unknown option %q", d.Val())
		}
	}
	return nil
}

func podIPs(svcName, namespace string) ([]string, error) {
	fqdn := fmt.Sprintf("%s%s.%s.%s", svcName, headlessSuffix, namespace, k8sSvcDomain)
	addrs, err := net.LookupHost(fqdn)
	if err != nil {
		return nil, fmt.Errorf("headless DNS %q: %w", fqdn, err)
	}
	return addrs, nil
}

func pickPod(cookieVal string, pods []string) string {
	if cookieVal != "" {
		for _, ip := range pods {
			if ip == cookieVal {
				return ip
			}
		}
		h := fnv.New32a()
		h.Write([]byte(cookieVal))
		return pods[h.Sum32()%uint32(len(pods))]
	}
	return pods[rand.Intn(len(pods))]
}

// =============================================================================
// HTTP middleware — http.handlers.cname_router
// =============================================================================

type CNAMERouter struct {
	shared
	CookieName  string `json:"cookie_name,omitempty"`
	ServicePort int    `json:"service_port,omitempty"`
}

func (CNAMERouter) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.handlers.cname_router",
		New: func() caddy.Module { return new(CNAMERouter) },
	}
}

func (r *CNAMERouter) UnmarshalCaddyfile(d *caddyfile.Dispenser) error {
	d.Next() // consume directive name
	for d.NextBlock(0) {
		switch d.Val() {
		case "base_domain":
			if !d.NextArg() {
				return d.ArgErr()
			}
			r.BaseDomain = d.Val()
		case "separator":
			if !d.NextArg() {
				return d.ArgErr()
			}
			r.Separator = d.Val()
		case "cache_ttl":
			if !d.NextArg() {
				return d.ArgErr()
			}
			dur, err := time.ParseDuration(d.Val())
			if err != nil {
				return d.Errf("invalid cache_ttl: %v", err)
			}
			r.CacheTTL = caddy.Duration(dur)
		case "negative_cache_ttl":
			if !d.NextArg() {
				return d.ArgErr()
			}
			dur, err := time.ParseDuration(d.Val())
			if err != nil {
				return d.Errf("invalid negative_cache_ttl: %v", err)
			}
			r.NegativeCacheTTL = caddy.Duration(dur)
		case "cookie_name":
			if !d.NextArg() {
				return d.ArgErr()
			}
			r.CookieName = d.Val()
		case "service_port":
			if !d.NextArg() {
				return d.ArgErr()
			}
			port, err := strconv.Atoi(d.Val())
			if err != nil {
				return d.Errf("invalid service_port: %v", err)
			}
			r.ServicePort = port
		default:
			return d.Errf("unknown option %q", d.Val())
		}
	}
	return nil
}

func (r *CNAMERouter) Provision(ctx caddy.Context) error {
	if err := r.shared.provision(ctx); err != nil {
		return err
	}
	if r.CookieName == "" {
		r.CookieName = defaultCookieName
	}
	if r.ServicePort == 0 {
		r.ServicePort = 80
	}
	return nil
}

func (r *CNAMERouter) ServeHTTP(w http.ResponseWriter, req *http.Request, next caddyhttp.Handler) error {
	host := req.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}

	svcName, namespace, err := r.tenant(host)
	if err != nil {
		r.logger.Debug("cname_router: no tenant, passing through",
			zap.String("host", host), zap.Error(err))
		return next.ServeHTTP(w, req)
	}

	pods, err := podIPs(svcName, namespace)
	if err != nil || len(pods) == 0 {
		r.logger.Warn("cname_router: no pods", zap.String("svc", svcName), zap.Error(err))
		return caddyhttp.Error(http.StatusBadGateway, fmt.Errorf("no pods for %s", svcName))
	}

	var cookieVal string
	if c, err := req.Cookie(r.CookieName); err == nil {
		cookieVal = c.Value
	}
	podIP := pickPod(cookieVal, pods)

	if cookieVal != podIP {
		http.SetCookie(w, &http.Cookie{
			Name:     r.CookieName,
			Value:    podIP,
			Path:     "/",
			HttpOnly: true,
			Secure:   true,
			SameSite: http.SameSiteLaxMode,
		})
	}

	target, _ := url.Parse(fmt.Sprintf("http://%s:%d", podIP, r.ServicePort))

	r.logger.Debug("cname_router: proxying",
		zap.String("host", host),
		zap.String("pod", podIP),
		zap.String("svc", svcName),
	)

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Director = func(r *http.Request) {
		r.URL.Scheme = target.Scheme
		r.URL.Host = target.Host
		if r.Header.Get("X-Forwarded-Host") == "" {
			r.Header.Set("X-Forwarded-Host", r.Host)
		}
	}
	proxy.ServeHTTP(w, req)
	return nil
}

var (
	_ caddy.Provisioner           = (*CNAMERouter)(nil)
	_ caddyhttp.MiddlewareHandler = (*CNAMERouter)(nil)
	_ caddyfile.Unmarshaler       = (*CNAMERouter)(nil)
)

// =============================================================================
// TLS permission — tls.permission.cname_router
// =============================================================================

type CNAMEPermission struct {
	shared
}

func (CNAMEPermission) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "tls.permission.cname_router",
		New: func() caddy.Module { return new(CNAMEPermission) },
	}
}

func (p *CNAMEPermission) UnmarshalCaddyfile(d *caddyfile.Dispenser) error {
	d.Next() // consume module name
	return p.shared.unmarshalShared(d)
}

func (p *CNAMEPermission) Provision(ctx caddy.Context) error {
	return p.shared.provision(ctx)
}

func (p *CNAMEPermission) CertificateAllowed(_ context.Context, name string) error {
	_, _, err := p.tenant(name)
	if err != nil {
		p.logger.Info("cname_router: TLS denied", zap.String("domain", name), zap.Error(err))
	}
	return err
}

var (
	_ caddy.Provisioner     = (*CNAMEPermission)(nil)
	_ caddyfile.Unmarshaler = (*CNAMEPermission)(nil)
)
