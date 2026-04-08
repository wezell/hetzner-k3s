// Package main implements a lightweight HTTP validation webhook for Caddy's
// on_demand_tls ask endpoint. It checks whether a requested domain's subdomain
// maps to an active Kubernetes namespace, returning 200 (allow) or 403 (deny).
//
// Usage: GET /check?domain=tenant-env.botcms.cloud
//   - Strips the base domain suffix to extract the subdomain label.
//   - Normalises the label to a valid namespace name (lowercase, hyphens).
//   - Checks the namespace exists and has the label app.kubernetes.io/managed-by=dotcms.
//   - Returns 200 if found, 403 otherwise.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

const (
	defaultPort       = "8080"
	defaultBaseDomain = "botcms.cloud"
	// Namespace label set by tenant-add.sh to identify managed tenants.
	managedByLabel = "app.kubernetes.io/managed-by=dotcms"
)

func main() {
	// Structured JSON logging — easy to parse in Loki / Grafana.
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	port := envOrDefault("PORT", defaultPort)
	baseDomain := envOrDefault("BASE_DOMAIN", defaultBaseDomain)

	client, err := buildK8sClient()
	if err != nil {
		slog.Error("failed to build Kubernetes client", "err", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/check", checkHandler(client, baseDomain))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})

	addr := ":" + port
	slog.Info("webhook server starting", "addr", addr, "base_domain", baseDomain)

	srv := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("server exited", "err", err)
		os.Exit(1)
	}
}

// checkHandler returns an http.HandlerFunc that validates the ?domain= parameter.
func checkHandler(client kubernetes.Interface, baseDomain string) http.HandlerFunc {
	suffix := "." + baseDomain // e.g. ".botcms.cloud"
	return func(w http.ResponseWriter, r *http.Request) {
		domain := r.URL.Query().Get("domain")
		if domain == "" {
			slog.Warn("missing domain parameter")
			http.Error(w, "missing domain parameter", http.StatusBadRequest)
			return
		}

		// Only handle subdomains of the configured base domain.
		if !strings.HasSuffix(domain, suffix) {
			slog.Info("domain not under base domain — denying", "domain", domain, "base_domain", baseDomain)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		// Extract subdomain: "acme-prod.botcms.cloud" → "acme-prod"
		sub := strings.TrimSuffix(domain, suffix)
		// Guard against nested subdomains like "x.acme-prod.botcms.cloud".
		if strings.Contains(sub, ".") {
			slog.Info("nested subdomain — denying", "domain", domain, "subdomain", sub)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		// Normalise to valid namespace name: lowercase only (hyphens already valid).
		ns := strings.ToLower(sub)

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		if namespaceExists(ctx, client, ns) {
			slog.Info("namespace found — allowing TLS", "domain", domain, "namespace", ns)
			w.WriteHeader(http.StatusOK)
			fmt.Fprintln(w, "allowed")
			return
		}

		slog.Info("namespace not found — denying TLS", "domain", domain, "namespace", ns)
		http.Error(w, "forbidden", http.StatusForbidden)
	}
}

// namespaceExists returns true when a namespace with the given name exists AND
// carries the managed-by label (so we only issue certs for dotCMS tenants).
func namespaceExists(ctx context.Context, client kubernetes.Interface, name string) bool {
	ns, err := client.CoreV1().Namespaces().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		// Not found or transient error — treat as deny.
		return false
	}
	labels := ns.GetLabels()
	return labels["app.kubernetes.io/managed-by"] == "dotcms"
}

// buildK8sClient constructs a client using in-cluster config when running
// inside a pod, falling back to KUBECONFIG for local development.
func buildK8sClient() (kubernetes.Interface, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		// Fallback: KUBECONFIG env or ~/.kube/config
		kubeconfig := envOrDefault("KUBECONFIG", clientcmd.RecommendedHomeFile)
		cfg, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
		if err != nil {
			return nil, fmt.Errorf("build kubeconfig: %w", err)
		}
	}
	return kubernetes.NewForConfig(cfg)
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
