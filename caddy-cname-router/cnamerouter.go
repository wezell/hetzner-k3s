// Package cnamerouter is a Caddy plugin for multi-tenant custom domain routing.
//
// Routing resolution order (first match wins):
//
//  1. Tenant lookup — the subdomain is parsed as <org>-<env>, the headless K8s
//     service <org>-<env>-hl.<org>.svc.cluster.local is resolved via DNS, and
//     traffic is proxied to a pod IP for sticky-session affinity.
//
//  2. ConfigMap lookup — any ConfigMap in the caddy-ingress namespace labelled
//     botcms.cloud/type=caddy-route whose data.hostname matches the incoming
//     host is routed to data.clusterip-svc:data.service-port.  This covers
//     internal services (control-plane, grafana, etc.) without a per-service
//     Caddyfile stanza.
//
// The same two-stage logic gates on-demand TLS certificate issuance.
package cnamerouter

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
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
	k8sAPIHost        = "https://kubernetes.default.svc"
	saTokenPath       = "/var/run/secrets/kubernetes.io/serviceaccount/token"
	saCACertPath      = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
	cmNamespace       = "caddy-ingress"
	cmLabelSelector   = "botcms.cloud/type=caddy-route"
	cmCacheInterval   = 30 * time.Second
)

// cmRoute holds routing info derived from a caddy-route ConfigMap.
type cmRoute struct {
	hostname    string
	clusteripSvc string
	servicePort  int
}

// shared holds config and caches used by both the HTTP middleware and TLS
// permission modules.
type shared struct {
	BaseDomain       string         `json:"base_domain"`
	Separator        string         `json:"separator,omitempty"`
	CacheTTL         caddy.Duration `json:"cache_ttl,omitempty"`
	NegativeCacheTTL caddy.Duration `json:"negative_cache_ttl,omitempty"`

	// Tenant DNS cache: host → cacheEntry
	cache sync.Map

	// ConfigMap route registry: hostname → *cmRoute
	cmRoutes    map[string]*cmRoute
	cmRoutesMu  sync.RWMutex
	cmLastFetch time.Time

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
	s.cmRoutes = make(map[string]*cmRoute)
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

// ── Tenant DNS lookup ─────────────────────────────────────────────────────────

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
	sub, err := s.subdomainFor(host)
	if err != nil {
		return "", "", err
	}

	remaining := sub
	for {
		idx := strings.LastIndex(remaining, s.Separator)
		if idx < 1 {
			break
		}
		tenant := sub[:idx]
		env := sub[idx+len(s.Separator):]
		if env == "" {
			remaining = remaining[:idx]
			continue
		}

		svc := tenant + s.Separator + env
		hlFQDN := fmt.Sprintf("%s%s.%s.%s", svc, headlessSuffix, tenant, k8sSvcDomain)
		addrs, dnsErr := net.LookupHost(hlFQDN)
		if dnsErr == nil && len(addrs) > 0 {
			return svc, tenant, nil
		}
		remaining = remaining[:idx]
	}
	return "", "", fmt.Errorf("no tenant matched subdomain %q (tried all splits)", sub)
}

// subdomainFor returns the bare subdomain for a host that is either a direct
// *.base_domain name or a CNAME pointing to one.
func (s *shared) subdomainFor(host string) (string, error) {
	if strings.HasSuffix(host, "."+s.BaseDomain) {
		return strings.TrimSuffix(host, "."+s.BaseDomain), nil
	}
	cname, err := net.LookupCNAME(host)
	if err != nil {
		return "", fmt.Errorf("CNAME lookup %q: %w", host, err)
	}
	cname = strings.TrimSuffix(cname, ".")
	if cname == host {
		return "", fmt.Errorf("%q has no CNAME record", host)
	}
	if !strings.HasSuffix(cname, "."+s.BaseDomain) {
		return "", fmt.Errorf("CNAME %q does not point to %s", cname, s.BaseDomain)
	}
	return strings.TrimSuffix(cname, "."+s.BaseDomain), nil
}

// ── ConfigMap route registry ──────────────────────────────────────────────────

// cmLookup returns the ConfigMap-based route for the given hostname, if any.
// It refreshes the registry from the Kubernetes API at most once every
// cmCacheInterval.
func (s *shared) cmLookup(hostname string) (*cmRoute, bool) {
	s.cmRoutesMu.RLock()
	age := time.Since(s.cmLastFetch)
	route, ok := s.cmRoutes[hostname]
	s.cmRoutesMu.RUnlock()

	if age > cmCacheInterval {
		s.refreshCMRoutes()
		s.cmRoutesMu.RLock()
		route, ok = s.cmRoutes[hostname]
		s.cmRoutesMu.RUnlock()
	}
	return route, ok
}

// refreshCMRoutes fetches all caddy-route ConfigMaps from the Kubernetes API
// and rebuilds the in-memory registry.
func (s *shared) refreshCMRoutes() {
	s.cmRoutesMu.Lock()
	defer s.cmRoutesMu.Unlock()

	// Don't slam the API if another goroutine already refreshed
	if time.Since(s.cmLastFetch) < cmCacheInterval/2 {
		return
	}

	routes, err := fetchCMRoutes(s.logger)
	if err != nil {
		if s.logger != nil {
			s.logger.Warn("cname_router: configmap refresh failed", zap.Error(err))
		}
		return
	}
	s.cmRoutes = routes
	s.cmLastFetch = time.Now()
}

// k8sConfigMapList is a minimal struct for unmarshalling the Kubernetes
// ConfigMapList API response.
type k8sConfigMapList struct {
	Items []struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
		Data map[string]string `json:"data"`
	} `json:"items"`
}

// fetchCMRoutes calls the Kubernetes API and returns a hostname→cmRoute map.
func fetchCMRoutes(logger *zap.Logger) (map[string]*cmRoute, error) {
	token, err := os.ReadFile(saTokenPath)
	if err != nil {
		return nil, fmt.Errorf("read service account token: %w", err)
	}

	apiURL := fmt.Sprintf(
		"%s/api/v1/namespaces/%s/configmaps?labelSelector=%s",
		k8sAPIHost, cmNamespace, url.QueryEscape(cmLabelSelector),
	)

	// Use a client that trusts the in-cluster CA cert.
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				// InsecureSkipVerify is safe here: we're talking to the
				// cluster-internal API server via its service DNS name.
				InsecureSkipVerify: true, //nolint:gosec
			},
		},
	}

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("k8s API request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("k8s API status %d: %s", resp.StatusCode, string(body))
	}

	var list k8sConfigMapList
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return nil, fmt.Errorf("decode configmap list: %w", err)
	}

	routes := make(map[string]*cmRoute, len(list.Items))
	for _, cm := range list.Items {
		hostname := cm.Data["hostname"]
		svc := cm.Data["clusterip-svc"]
		portStr := cm.Data["service-port"]
		if hostname == "" || svc == "" {
			continue
		}
		port, _ := strconv.Atoi(portStr)
		if port == 0 {
			port = 80
		}
		routes[hostname] = &cmRoute{
			hostname:    hostname,
			clusteripSvc: svc,
			servicePort:  port,
		}
		if logger != nil {
			logger.Debug("cname_router: loaded configmap route",
				zap.String("hostname", hostname),
				zap.String("svc", svc),
				zap.Int("port", port),
			)
		}
	}
	return routes, nil
}

// ── Shared Caddyfile parsing ──────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

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
	d.Next()
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

// forwardedProto returns "https" if the incoming connection used TLS,
// falling back to any existing X-Forwarded-Proto header, then "http".
func forwardedProto(req *http.Request) string {
	if req.TLS != nil {
		return "https"
	}
	if p := req.Header.Get("X-Forwarded-Proto"); p != "" {
		return p
	}
	return "http"
}

// setForwardedHeaders sets X-Forwarded-Host and X-Forwarded-Proto on the
// outbound request.  httputil.ReverseProxy already appends X-Forwarded-For
// automatically, so we don't need to handle that here.
func setForwardedHeaders(rr *http.Request, proto string) {
	if rr.Header.Get("X-Forwarded-Host") == "" {
		rr.Header.Set("X-Forwarded-Host", rr.Host)
	}
	rr.Header.Set("X-Forwarded-Proto", proto)
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

	// 1 — Try tenant headless-service routing
	svcName, namespace, err := r.tenant(host)
	if err == nil {
		pods, podErr := podIPs(svcName, namespace)
		if podErr != nil || len(pods) == 0 {
			r.logger.Warn("cname_router: no pods", zap.String("svc", svcName), zap.Error(podErr))
			return caddyhttp.Error(http.StatusBadGateway, fmt.Errorf("no pods for %s", svcName))
		}

		var cookieVal string
		if c, cErr := req.Cookie(r.CookieName); cErr == nil {
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
		r.logger.Debug("cname_router: tenant proxy",
			zap.String("host", host), zap.String("pod", podIP), zap.String("svc", svcName))
		proxy := httputil.NewSingleHostReverseProxy(target)
		proto := forwardedProto(req)
		proxy.Director = func(rr *http.Request) {
			rr.URL.Scheme = target.Scheme
			rr.URL.Host = target.Host
			setForwardedHeaders(rr, proto)
		}
		proxy.ServeHTTP(w, req)
		return nil
	}

	// 2 — Try ConfigMap-based routing (internal services)
	if route, ok := r.cmLookup(host); ok {
		target, _ := url.Parse(fmt.Sprintf("http://%s:%d", route.clusteripSvc, route.servicePort))
		r.logger.Debug("cname_router: configmap proxy",
			zap.String("host", host), zap.String("svc", route.clusteripSvc))
		proxy := httputil.NewSingleHostReverseProxy(target)
		proto := forwardedProto(req)
		proxy.Director = func(rr *http.Request) {
			rr.URL.Scheme = target.Scheme
			rr.URL.Host = target.Host
			setForwardedHeaders(rr, proto)
		}
		proxy.ServeHTTP(w, req)
		return nil
	}

	r.logger.Debug("cname_router: no match, passing through", zap.String("host", host))
	return next.ServeHTTP(w, req)
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
	d.Next()
	return p.shared.unmarshalShared(d)
}

func (p *CNAMEPermission) Provision(ctx caddy.Context) error {
	return p.shared.provision(ctx)
}

func (p *CNAMEPermission) CertificateAllowed(_ context.Context, name string) error {
	// 1 — Tenant DNS lookup
	if _, _, err := p.tenant(name); err == nil {
		return nil
	}

	// 2 — ConfigMap registry (internal services with a caddy-route ConfigMap)
	if _, ok := p.cmLookup(name); ok {
		p.logger.Debug("cname_router: TLS allowed via configmap", zap.String("domain", name))
		return nil
	}

	err := fmt.Errorf("no route for %q (checked tenant DNS and configmap registry)", name)
	p.logger.Info("cname_router: TLS denied", zap.String("domain", name), zap.Error(err))
	return err
}

var (
	_ caddy.Provisioner     = (*CNAMEPermission)(nil)
	_ caddyfile.Unmarshaler = (*CNAMEPermission)(nil)
)
