package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed web/index.html web/styles.css web/app.js web/favicon.svg web/lib/*.js web/ui/*.js web/workers/*.js
var content embed.FS

var version = "0.8.0"

type config struct {
	remote      bool
	mcp         bool
	host        string
	port        int
	window      string
	keepRunning bool
	dataDir     string
	noStore     bool
	dev         bool
	showVersion bool
	files       []string
	watch       string
	watchEvery  time.Duration
}

type app struct {
	session  string
	control  *remoteHub
	dev      bool
	assetDir string
	assets   fs.FS
	files    *localFiles
	store    *store
	watch    *folderWatch
}

func init() {
	if err := mime.AddExtensionType(".js", "text/javascript; charset=utf-8"); err != nil {
		log.Printf("mime registration warning: %v", err)
	}
	if err := mime.AddExtensionType(".mjs", "text/javascript; charset=utf-8"); err != nil {
		log.Printf("mime registration warning: %v", err)
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "mcp" {
		os.Exit(runMCP(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	if len(os.Args) > 1 && os.Args[1] == "run" {
		os.Exit(runHeadless(os.Args[2:], os.Stdout, os.Stderr))
	}
	if len(os.Args) > 1 && os.Args[1] == "verify" {
		os.Exit(runVerify(os.Args[2:], os.Stdout, os.Stderr))
	}
	cfg, err := parseConfig(os.Args[1:])
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		os.Exit(2)
	}
	if cfg.showVersion {
		fmt.Printf("cytoweave %s\n", version)
		return
	}
	// A CytoWeave already running on the preferred port gets the files and a new window,
	// so the workspace library (kept per origin by the browser) stays in one place.
	if existing := findRunning(cfg.host, cfg.port); existing != "" && !cfg.remote {
		if len(cfg.files) > 0 {
			if err := forwardFiles(existing, cfg.files); err != nil {
				log.Printf("could not pass the files to the running CytoWeave: %v", err)
			}
		}
		fmt.Printf("CytoWeave is already running at %s\n", existing)
		if cfg.window != "none" {
			if _, err := openWindow(existing, cfg.window, cfg.dataDir); err != nil {
				log.Printf("open window: %v", err)
			}
		}
		return
	}
	running, err := start(cfg, os.Stdout)
	if err != nil {
		log.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- running.serve() }()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-done:
		if err != nil {
			log.Fatalf("server error: %v", err)
		}
	case <-signals:
		running.stop(3 * time.Second)
	case <-running.windowClosed:
		fmt.Println("The CytoWeave window was closed; stopping.")
		running.stop(3 * time.Second)
	}
}

// A prepared server: the app, its listener and address.
type runningServer struct {
	app          *app
	server       *http.Server
	listener     net.Listener
	url          string
	cancel       context.CancelFunc
	windowClosed <-chan struct{}
	// connection: the remote.json scripts read (connection.go), removed on stop.
	connection string
}

func (s *runningServer) stop(timeout time.Duration) {
	if s.connection != "" {
		removeConnectionFile(s.connection, s.app.control.token)
	}
	s.cancel()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	s.server.Shutdown(ctx)
}

func (s *runningServer) serve() error {
	if err := s.server.Serve(s.listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// start prepares the app, listens, prints the banner to out and opens the window.
func start(cfg config, out io.Writer) (*runningServer, error) {
	a, err := newApp(cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to prepare app: %w", err)
	}
	handler, err := a.handler()
	if err != nil {
		return nil, fmt.Errorf("failed to prepare app: %w", err)
	}
	listener, actualPort, err := listen(cfg.host, cfg.port)
	if err != nil {
		return nil, fmt.Errorf("failed to listen: %w", err)
	}
	url := "http://" + net.JoinHostPort(cfg.host, strconv.Itoa(actualPort))
	connection := ""
	if a.control != nil && a.control.scripts && cfg.dataDir != "" {
		if connection, err = writeConnectionFile(cfg.dataDir, url, a.control.token); err != nil {
			log.Printf("could not write the connection file for scripts: %v", err)
			connection = ""
		}
	}
	a.printBanner(out, url, connection)
	base, cancel := context.WithCancel(context.Background())
	server := &http.Server{
		Handler:           protect(handler, cfg.host, actualPort),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return base },
	}
	running := &runningServer{app: a, server: server, listener: listener, url: url, cancel: cancel, connection: connection}
	if cfg.window != "none" {
		closed := make(chan struct{})
		running.windowClosed = closed
		go func() {
			time.Sleep(250 * time.Millisecond)
			wait, err := openWindow(url, cfg.window, cfg.dataDir)
			if err != nil {
				log.Printf("open window: %v", err)
				return
			}
			// An app window with its own browser profile tells us when it closes; the
			// default browser does not, so the server keeps running until Ctrl+C.
			if wait != nil && !cfg.keepRunning {
				opened := time.Now()
				wait()
				// A browser already running with this profile (on macOS, Chrome keeps
				// running after its last window closes) takes the window over and the
				// process started here exits at once: that is not the window closing.
				if time.Since(opened) < handOffTime {
					fmt.Fprintln(out, "The window opened in a CytoWeave browser that was already running; CytoWeave keeps serving until you press Ctrl+C (or quit that browser with Cmd+Q and start again).")
					return
				}
				close(closed)
			}
		}()
	}
	return running, nil
}

// A window process that exits sooner than this handed the window to a browser already running.
const handOffTime = 5 * time.Second

func parseConfig(args []string) (config, error) {
	var cfg config
	flags := flag.NewFlagSet("cytoweave", flag.ContinueOnError)
	flags.StringVar(&cfg.host, "host", "127.0.0.1", "host interface to bind")
	flags.IntVar(&cfg.port, "port", 8770, "preferred localhost port")
	flags.StringVar(&cfg.window, "window", "app", "how to show CytoWeave: app (a desktop window from Chrome, Edge, Brave or Chromium, else the default browser), browser (the default browser) or none")
	flags.BoolVar(&cfg.keepRunning, "keep-running", false, "keep serving after the app window is closed")
	flags.StringVar(&cfg.dataDir, "data-dir", "", "folder for the workspace library (default: <user config dir>/CytoWeave)")
	flags.BoolVar(&cfg.noStore, "no-library", false, "do not keep a workspace library on disk (the browser's own storage is used)")
	flags.BoolVar(&cfg.dev, "dev", false, "serve web/ from the working directory instead of the embedded copy")
	flags.BoolVar(&cfg.showVersion, "version", false, "print the version and exit")
	flags.StringVar(&cfg.watch, "watch", "", "watch a folder for FCS files as they are acquired (QC → Live), for example the instrument's export folder; it is only read")
	flags.DurationVar(&cfg.watchEvery, "watch-interval", defaultWatchInterval, "how often the watched folder is checked")
	flags.BoolVar(&cfg.remote, "remote-control", false, "accept actions from programs on this computer at /api/remote/action (for example Python or Jupyter)")
	noOpen := flags.Bool("no-open", false, "same as --window none")
	flags.Usage = func() {
		fmt.Fprintln(flags.Output(), "Usage: cytoweave [flags] [FCS files, folders of FCS files, workspaces (.cwz), Gating-ML or FlowJo .wsp and .flowjo files...]")
		fmt.Fprintln(flags.Output(), "       cytoweave mcp [flags]   (a Model Context Protocol server for AI agents, on stdin and stdout)")
		fmt.Fprintln(flags.Output(), "       cytoweave run --template panel.cwt --output results/ FILES...   (an analysis without a window; cytoweave run -h)")
		flags.PrintDefaults()
	}
	files, err := parseArgs(flags, args)
	if *noOpen {
		cfg.window = "none"
	}
	switch cfg.window {
	case "app", "browser", "none":
	default:
		if err == nil {
			fmt.Fprintf(flags.Output(), "--window must be app, browser or none, not %q\n", cfg.window)
			err = errors.New("invalid --window")
		}
	}
	if cfg.dataDir == "" && err == nil {
		cfg.dataDir = defaultDataDir()
	}
	cfg.files = files
	return cfg, err
}

// parseArgs lets flags follow file names, as in "cytoweave plate1/ --port 9000".
func parseArgs(flags *flag.FlagSet, args []string) ([]string, error) {
	var positional []string
	for {
		if err := flags.Parse(args); err != nil {
			return nil, err
		}
		rest := flags.Args()
		if len(rest) == 0 {
			return positional, nil
		}
		if consumed := len(args) - len(rest); consumed > 0 && args[consumed-1] == "--" {
			return append(positional, rest...), nil
		}
		positional = append(positional, rest[0])
		args = rest[1:]
	}
}

func newApp(cfg config) (*app, error) {
	a := &app{
		session: strconv.FormatInt(time.Now().UnixNano(), 36),
		dev:     cfg.dev,
		assets:  content,
		files:   newLocalFiles(),
	}
	a.watch = newFolderWatch(a.files)
	if cfg.watch != "" {
		if err := a.watch.start(cfg.watch, cfg.watchEvery); err != nil {
			return nil, err
		}
	}
	if problems := a.files.add(cfg.files); len(problems) > 0 {
		for _, problem := range problems {
			log.Print(problem)
		}
	}
	if cfg.remote {
		a.control = newRemoteHub()
		a.control.open = a.files.register
		a.control.scripts = !cfg.mcp
	}
	if !cfg.noStore {
		s, err := openStore(cfg.dataDir)
		if err != nil {
			log.Printf("workspace library disabled: %v", err)
		} else {
			a.store = s
		}
	}
	if !cfg.dev {
		return a, nil
	}
	dir, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	a.assetDir = dir
	a.assets = os.DirFS(dir)
	if _, err := fs.Stat(a.assets, "web/index.html"); err != nil {
		return nil, fmt.Errorf("--dev must be run from the repository root: %w", err)
	}
	return a, nil
}

func (a *app) printBanner(out io.Writer, url, connection string) {
	fmt.Fprintf(out, "CytoWeave %s is running at %s\n", version, url)
	if a.dev {
		fmt.Fprintf(out, "Dev mode: serving web/ from disk in %s (no-store)\n", a.assetDir)
	}
	if a.store != nil {
		fmt.Fprintf(out, "Workspace library: %s\n", a.store.dir)
	} else {
		fmt.Fprintln(out, "Workspace library: kept by the browser")
	}
	if n := len(a.files.opened()); n > 0 {
		fmt.Fprintf(out, "Opening %d file(s) named on the command line\n", n)
	}
	if status := a.watch.status(0); status.Watching {
		fmt.Fprintf(out, "Watching %s for new FCS files (QC → Live); %d already there\n", status.Folder, status.Existing)
	}
	if a.control != nil && a.control.scripts {
		fmt.Fprintf(out, "Remote control: POST {\"action\": ..., \"args\": {...}} to %s/api/remote/action\n", url)
		fmt.Fprintf(out, "Opening files by path (open_files) and writing files (the export actions) need the header %s: %s\n", remoteTokenHeader, a.control.token)
		if connection != "" {
			fmt.Fprintln(out, connectionNotice(connection))
		}
	}
	fmt.Fprintln(out, "Press Ctrl+C to stop.")
}

func (a *app) handler() (http.Handler, error) {
	webFS, err := fs.Sub(a.assets, "web")
	if err != nil {
		return nil, err
	}
	webCache := "no-cache"
	if a.dev {
		webCache = "no-store"
	}
	mux := http.NewServeMux()
	a.registerAPI(mux)
	mux.Handle("/", cacheControl(webCache, staticHandler(webFS)))
	return mux, nil
}

type info struct {
	Name          string      `json:"name"`
	Session       string      `json:"session"`
	RemoteControl bool        `json:"remoteControl"`
	Version       string      `json:"version"`
	Mode          string      `json:"mode"`
	Library       bool        `json:"library"`
	DataDir       string      `json:"dataDir,omitempty"`
	Files         []localFile `json:"files"`
	Platform      string      `json:"platform"`
	Watching      string      `json:"watching,omitempty"`
}

func (a *app) registerAPI(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/info", func(w http.ResponseWriter, r *http.Request) {
		body := info{Name: "CytoWeave", Session: a.session, RemoteControl: a.control != nil, Version: version, Mode: "desktop", Files: a.files.opened(), Platform: platformName(), Watching: a.watch.status(0).Folder}
		if a.store != nil {
			body.Library = true
			body.DataDir = a.store.dir
		}
		writeJSON(w, body)
	})
	mux.HandleFunc("GET /api/local/{index}", a.files.serve)
	mux.HandleFunc("POST /api/open", a.openPaths)
	a.watch.register(mux)
	if a.control != nil {
		a.control.register(mux)
	}
	if a.store != nil {
		a.store.register(mux)
		mux.HandleFunc("POST /api/library/local/{index}", func(w http.ResponseWriter, r *http.Request) {
			path, ok := a.files.path(r.PathValue("index"))
			if !ok {
				writeError(w, http.StatusNotFound, "No such local file.")
				return
			}
			a.store.addLocalFile(w, path)
		})
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "Unknown API endpoint.")
	})
}

// openPaths adds files named by a second "cytoweave <files>" launch; only this computer may ask.
func (a *app) openPaths(w http.ResponseWriter, r *http.Request) {
	if !isLoopbackRequest(r) {
		writeError(w, http.StatusForbidden, "Only this computer may open files.")
		return
	}
	var body struct {
		Paths []string `json:"paths"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Send {\"paths\": [...]}.")
		return
	}
	problems := a.files.add(body.Paths)
	writeJSON(w, map[string]any{"files": a.files.opened(), "problems": problems})
}

func listen(host string, port int) (net.Listener, int, error) {
	var lastErr error
	for offset := 0; offset < 20; offset++ {
		candidate := port + offset
		listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(candidate)))
		if err == nil {
			return listener, listener.Addr().(*net.TCPAddr).Port, nil
		}
		lastErr = err
	}
	return nil, 0, lastErr
}

// findRunning returns the URL of a CytoWeave already serving on host:port, or "".
func findRunning(host string, port int) string {
	url := "http://" + net.JoinHostPort(host, strconv.Itoa(port))
	client := http.Client{Timeout: 400 * time.Millisecond}
	response, err := client.Get(url + "/api/info")
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	var body info
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&body) != nil {
		return ""
	}
	if body.Name != "CytoWeave" {
		return ""
	}
	return url
}

func forwardFiles(url string, paths []string) error {
	absolute := make([]string, 0, len(paths))
	for _, path := range paths {
		if abs, err := absPath(path); err == nil {
			absolute = append(absolute, abs)
		}
	}
	payload, _ := json.Marshal(map[string]any{"paths": absolute})
	request, err := http.NewRequest(http.MethodPost, url+"/api/open", strings.NewReader(string(payload)))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", response.StatusCode)
	}
	return nil
}

func cacheControl(value string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", value)
		next.ServeHTTP(w, r)
	})
}

// staticHandler serves the web app; unknown paths without an extension get index.html.
func staticHandler(webFS fs.FS) http.Handler {
	files := http.FileServer(http.FS(webFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			files.ServeHTTP(w, r)
			return
		}
		if _, err := fs.Stat(webFS, name); err != nil {
			if !strings.Contains(name[strings.LastIndex(name, "/")+1:], ".") {
				r2 := r.Clone(r.Context())
				r2.URL.Path = "/"
				files.ServeHTTP(w, r2)
				return
			}
			writeError(w, http.StatusNotFound, "Not found.")
			return
		}
		files.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write json: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}
