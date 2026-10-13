package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func testApp(t *testing.T, files ...string) (*app, http.Handler) {
	t.Helper()
	dir := t.TempDir()
	a, err := newApp(config{dataDir: dir, files: files})
	if err != nil {
		t.Fatal(err)
	}
	handler, err := a.handler()
	if err != nil {
		t.Fatal(err)
	}
	return a, protect(handler, "127.0.0.1", 8770)
}

func request(t *testing.T, handler http.Handler, method, target string, body io.Reader, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, body)
	req.Host = "127.0.0.1:8770"
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestServesTheAppWithSecurityHeaders(t *testing.T) {
	_, handler := testApp(t)
	rec := request(t, handler, http.MethodGet, "/", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "CytoWeave") {
		t.Fatal("index.html not served")
	}
	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src 'self';") {
		t.Fatalf("missing CSP: %q", csp)
	}
	// Requests go to this server, and to Cirro only: its tenants, their sign-in and their storage.
	if !strings.Contains(csp, "connect-src 'self' https://*.cirro.bio https://*.amazoncognito.com https://*.amazonaws.com;") {
		t.Fatalf("connect-src is not this server and Cirro: %q", csp)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("missing nosniff")
	}
	if rec.Header().Get("Cross-Origin-Embedder-Policy") != "require-corp" || rec.Header().Get("Cross-Origin-Opener-Policy") != "same-origin" {
		t.Fatal("the page is not cross-origin isolated (shared memory for workers)")
	}
	js := request(t, handler, http.MethodGet, "/app.js", nil, nil)
	if !strings.HasPrefix(js.Header().Get("Content-Type"), "text/javascript") {
		t.Fatalf("app.js content type %q", js.Header().Get("Content-Type"))
	}
	lib := request(t, handler, http.MethodGet, "/lib/fcs.js", nil, nil)
	if lib.Code != http.StatusOK {
		t.Fatalf("lib/fcs.js status %d", lib.Code)
	}
}

func TestInfoDescribesTheDesktopProgram(t *testing.T) {
	_, handler := testApp(t)
	rec := request(t, handler, http.MethodGet, "/api/info", nil, nil)
	var body info
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Name != "CytoWeave" || body.Version != version || !body.Library || body.Session == "" {
		t.Fatalf("unexpected info %+v", body)
	}
}

func TestRejectsForeignHostsAndCrossOriginAPI(t *testing.T) {
	_, handler := testApp(t)
	req := httptest.NewRequest(http.MethodGet, "/api/info", nil)
	req.Host = "evil.example:8770"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("DNS-rebinding host allowed: %d", rec.Code)
	}
	cross := request(t, handler, http.MethodPut, "/api/library/workspaces/abc", strings.NewReader("{}"), map[string]string{"Origin": "https://evil.example"})
	if cross.Code != http.StatusForbidden {
		t.Fatalf("cross-origin write allowed: %d", cross.Code)
	}
	site := request(t, handler, http.MethodGet, "/api/info", nil, map[string]string{"Sec-Fetch-Site": "cross-site"})
	if site.Code != http.StatusForbidden {
		t.Fatalf("cross-site fetch allowed: %d", site.Code)
	}
	same := request(t, handler, http.MethodGet, "/api/info", nil, map[string]string{"Origin": "http://127.0.0.1:8770", "Sec-Fetch-Site": "same-origin"})
	if same.Code != http.StatusOK {
		t.Fatalf("same-origin request refused: %d", same.Code)
	}
}

func TestWorkspaceLibraryRoundTrip(t *testing.T) {
	_, handler := testApp(t)
	doc := `{"format":"cytoweave-workspace","version":1,"name":"Plate 1","modified":"2026-10-01T12:00:00Z","samples":[{},{}]}`
	put := request(t, handler, http.MethodPut, "/api/library/workspaces/w1", strings.NewReader(doc), nil)
	if put.Code != http.StatusOK {
		t.Fatalf("put %d %s", put.Code, put.Body)
	}
	list := request(t, handler, http.MethodGet, "/api/library/workspaces", nil, nil)
	var listed struct {
		Workspaces []workspaceSummary `json:"workspaces"`
	}
	json.NewDecoder(list.Body).Decode(&listed)
	if len(listed.Workspaces) != 1 || listed.Workspaces[0].Name != "Plate 1" || listed.Workspaces[0].Samples != 2 {
		t.Fatalf("unexpected list %+v", listed)
	}
	get := request(t, handler, http.MethodGet, "/api/library/workspaces/w1", nil, nil)
	if get.Body.String() != doc {
		t.Fatalf("round trip changed the document: %s", get.Body)
	}
	if bad := request(t, handler, http.MethodPut, "/api/library/workspaces/w2", strings.NewReader("{not json"), nil); bad.Code != http.StatusBadRequest {
		t.Fatalf("invalid JSON accepted: %d", bad.Code)
	}
	if traversal := request(t, handler, http.MethodGet, "/api/library/workspaces/..%2Fsecret", nil, nil); traversal.Code == http.StatusOK {
		t.Fatal("path traversal allowed")
	}
	del := request(t, handler, http.MethodDelete, "/api/library/workspaces/w1", nil, nil)
	if del.Code != http.StatusOK {
		t.Fatalf("delete %d", del.Code)
	}
	if gone := request(t, handler, http.MethodGet, "/api/library/workspaces/w1", nil, nil); gone.Code != http.StatusNotFound {
		t.Fatalf("deleted workspace still served: %d", gone.Code)
	}
}

func TestRecordsRoundTripByKind(t *testing.T) {
	_, handler := testApp(t)
	if empty := request(t, handler, http.MethodGet, "/api/library/records/instrument-qc", nil, nil); !strings.Contains(empty.Body.String(), `"records":[]`) {
		t.Fatalf("empty list: %s", empty.Body)
	}
	doc := `{"name":"LSRFortessa SIM-1","modified":"2026-10-03T08:00:00Z","runs":[]}`
	if put := request(t, handler, http.MethodPut, "/api/library/records/instrument-qc/i1", strings.NewReader(doc), nil); put.Code != http.StatusOK {
		t.Fatalf("put %d %s", put.Code, put.Body)
	}
	list := request(t, handler, http.MethodGet, "/api/library/records/instrument-qc", nil, nil)
	var listed struct {
		Records []recordSummary `json:"records"`
	}
	json.NewDecoder(list.Body).Decode(&listed)
	if len(listed.Records) != 1 || listed.Records[0].ID != "i1" || listed.Records[0].Name != "LSRFortessa SIM-1" {
		t.Fatalf("unexpected list %+v", listed)
	}
	if get := request(t, handler, http.MethodGet, "/api/library/records/instrument-qc/i1", nil, nil); get.Body.String() != doc {
		t.Fatalf("round trip changed the record: %s", get.Body)
	}
	if other := request(t, handler, http.MethodGet, "/api/library/records/spectra/i1", nil, nil); other.Code != http.StatusNotFound {
		t.Fatalf("records leak across kinds: %d", other.Code)
	}
	if bad := request(t, handler, http.MethodPut, "/api/library/records/Bad_Kind/i1", strings.NewReader("{}"), nil); bad.Code != http.StatusBadRequest {
		t.Fatalf("invalid kind accepted: %d", bad.Code)
	}
	if bad := request(t, handler, http.MethodPut, "/api/library/records/spectra/x", strings.NewReader("{oops"), nil); bad.Code != http.StatusBadRequest {
		t.Fatalf("invalid JSON accepted: %d", bad.Code)
	}
	if del := request(t, handler, http.MethodDelete, "/api/library/records/instrument-qc/i1", nil, nil); del.Code != http.StatusOK {
		t.Fatalf("delete %d", del.Code)
	}
	if gone := request(t, handler, http.MethodGet, "/api/library/records/instrument-qc/i1", nil, nil); gone.Code != http.StatusNotFound {
		t.Fatalf("deleted record still served: %d", gone.Code)
	}
}

func TestFilesAreStoredUnderTheirHash(t *testing.T) {
	a, handler := testApp(t)
	content := []byte("FCS3.1    pretend event data")
	sum := sha256.Sum256(content)
	sha := hex.EncodeToString(sum[:])
	wrong := strings.Repeat("0", 64)
	if rec := request(t, handler, http.MethodPut, "/api/library/files/"+wrong, bytes.NewReader(content), nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("mismatched hash accepted: %d", rec.Code)
	}
	if rec := request(t, handler, http.MethodPut, "/api/library/files/"+sha, bytes.NewReader(content), nil); rec.Code != http.StatusOK {
		t.Fatalf("put %d %s", rec.Code, rec.Body)
	}
	has := request(t, handler, http.MethodGet, "/api/library/has/"+sha, nil, nil)
	if !strings.Contains(has.Body.String(), `"exists":true`) {
		t.Fatalf("has: %s", has.Body)
	}
	missing := request(t, handler, http.MethodGet, "/api/library/has/"+wrong, nil, nil)
	if !strings.Contains(missing.Body.String(), `"exists":false`) {
		t.Fatalf("has missing: %s", missing.Body)
	}
	get := request(t, handler, http.MethodGet, "/api/library/files/"+sha, nil, nil)
	if !bytes.Equal(get.Body.Bytes(), content) {
		t.Fatal("stored file differs")
	}
	if _, err := os.Stat(filepath.Join(a.store.dir, "files", sha[:2], sha+".fcs")); err != nil {
		t.Fatalf("file not at its content address: %v", err)
	}
}

func TestFilesAreAddedUnderTheHashTheProgramComputes(t *testing.T) {
	dir := t.TempDir()
	local := filepath.Join(dir, "big.fcs")
	content := []byte("FCS3.1    a local file to copy into the library")
	os.WriteFile(local, content, 0o644)
	a, handler := testApp(t, local)
	sum := sha256.Sum256(content)
	sha := hex.EncodeToString(sum[:])
	same := map[string]string{"Sec-Fetch-Site": "same-origin"}
	var body struct {
		SHA256   string `json:"sha256"`
		Size     int64  `json:"size"`
		Existing bool   `json:"existing"`
	}
	rec := request(t, handler, http.MethodPost, "/api/library/local/0", nil, same)
	if rec.Code != http.StatusOK {
		t.Fatalf("local copy %d %s", rec.Code, rec.Body)
	}
	json.NewDecoder(rec.Body).Decode(&body)
	if body.SHA256 != sha || body.Size != int64(len(content)) || body.Existing {
		t.Fatalf("local copy answered %+v", body)
	}
	if _, err := os.Stat(filepath.Join(a.store.dir, "files", sha[:2], sha+".fcs")); err != nil {
		t.Fatalf("local file not at its content address: %v", err)
	}
	rec = request(t, handler, http.MethodPost, "/api/library/files", bytes.NewReader(content), same)
	json.NewDecoder(rec.Body).Decode(&body)
	if rec.Code != http.StatusOK || body.SHA256 != sha || !body.Existing {
		t.Fatalf("upload of a stored file: %d %+v", rec.Code, body)
	}
	other := []byte("FCS3.1    another file")
	rec = request(t, handler, http.MethodPost, "/api/library/files", bytes.NewReader(other), same)
	json.NewDecoder(rec.Body).Decode(&body)
	otherSum := sha256.Sum256(other)
	if rec.Code != http.StatusOK || body.SHA256 != hex.EncodeToString(otherSum[:]) || body.Existing {
		t.Fatalf("upload: %d %+v", rec.Code, body)
	}
	// Range requests read part of a stored file (the browser streams large files this way).
	part := request(t, handler, http.MethodGet, "/api/library/files/"+sha, nil, map[string]string{"Range": "bytes=10-14"})
	if part.Code != http.StatusPartialContent || part.Body.String() != string(content[10:15]) {
		t.Fatalf("range: %d %q", part.Code, part.Body.String())
	}
	if rec := request(t, handler, http.MethodPost, "/api/library/local/7", nil, same); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown local file: %d", rec.Code)
	}
	if rec := request(t, handler, http.MethodPost, "/api/library/files", bytes.NewReader(content), map[string]string{"Origin": "https://example.com"}); rec.Code == http.StatusOK {
		t.Fatal("cross-origin upload accepted")
	}
	entries, _ := os.ReadDir(filepath.Join(a.store.dir, "files"))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".upload-") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
}

func TestLocalFilesFromFoldersAreServed(t *testing.T) {
	dir := t.TempDir()
	plate := filepath.Join(dir, "plate1")
	os.MkdirAll(filepath.Join(plate, ".hidden"), 0o755)
	for _, name := range []string{"A10.fcs", "A2.fcs", "A1.fcs", "notes.txt", ".hidden/x.fcs"} {
		os.WriteFile(filepath.Join(plate, name), []byte("data "+name), 0o644)
	}
	_, handler := testApp(t, plate)
	rec := request(t, handler, http.MethodGet, "/api/info", nil, nil)
	var body info
	json.NewDecoder(rec.Body).Decode(&body)
	var names []string
	for _, f := range body.Files {
		names = append(names, f.Name)
		if f.Folder != "plate1" || f.Kind != "fcs" {
			t.Fatalf("unexpected file %+v", f)
		}
	}
	if strings.Join(names, ",") != "A1.fcs,A2.fcs,A10.fcs" {
		t.Fatalf("files not in natural order or hidden files included: %v", names)
	}
	served := request(t, handler, http.MethodGet, body.Files[2].URL, nil, nil)
	if served.Body.String() != "data A10.fcs" {
		t.Fatalf("served %q", served.Body.String())
	}
	if rec := request(t, handler, http.MethodGet, "/api/local/99", nil, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown local file: %d", rec.Code)
	}
}

func TestOpenRequiresThisComputer(t *testing.T) {
	_, handler := testApp(t)
	req := httptest.NewRequest(http.MethodPost, "/api/open", strings.NewReader(`{"paths":["/tmp"]}`))
	req.Host = "127.0.0.1:8770"
	req.RemoteAddr = "10.0.0.5:5555"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("remote peer allowed to open files: %d", rec.Code)
	}
}

func TestNaturalOrder(t *testing.T) {
	names := []string{"Well 10", "well 2", "Well 1", "Plate B3", "Plate A11", "Plate A3"}
	sort.Slice(names, func(i, j int) bool { return naturalLess(names[i], names[j]) })
	want := "Plate A3,Plate A11,Plate B3,Well 1,well 2,Well 10"
	if got := strings.Join(names, ","); got != want {
		t.Fatalf("got %s", got)
	}
}

func TestParseConfig(t *testing.T) {
	cfg, err := parseConfig([]string{"plate/", "--port", "9000", "--window", "none", "a.fcs"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.port != 9000 || cfg.window != "none" || len(cfg.files) != 2 || cfg.dataDir == "" {
		t.Fatalf("unexpected config %+v", cfg)
	}
	if _, err := parseConfig([]string{"--window", "fullscreen"}); err == nil {
		t.Fatal("invalid --window accepted")
	}
	noOpen, _ := parseConfig([]string{"--no-open"})
	if noOpen.window != "none" {
		t.Fatal("--no-open should mean --window none")
	}
}

func TestFileKinds(t *testing.T) {
	cases := map[string]string{"a.FCS": "fcs", "b.lmd": "fcs", "w.cwz": "workspace", "x.wsp": "flowjo", "y.flowjo": "flowjo", "g.xml": "gatingml", "e.Expt": "spectroflo", "t.csv": "table", "p.acs": "archive", "f.svg": "figure", "f.PNG": "figure", "f.pdf": "figure", "r.txt": ""}
	for name, want := range cases {
		if got := fileKind(name); got != want {
			t.Errorf("%s: %q, want %q", name, got, want)
		}
	}
}
