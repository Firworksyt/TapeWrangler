package main

// HTTP client for the TapeWrangler server API.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	cfg  Config
	http *http.Client
}

func newClient(cfg Config) *Client {
	// No overall timeout: uploading a big file list can take a while.
	return &Client{cfg: cfg, http: &http.Client{}}
}

// Tape mirrors the server's JSON view of a tape (only the fields we use).
type Tape struct {
	Barcode       string   `json:"barcode"`
	Name          string   `json:"name"`
	Location      *string  `json:"location"`
	Generation    string   `json:"generation"`
	Status        string   `json:"status"`
	FileCount     int64    `json:"file_count"`
	UsedBytes     int64    `json:"used_bytes"`
	CapacityBytes *float64 `json:"capacity_bytes"`
	LastIndexedAt *string  `json:"last_indexed_at"`
	LastVerifyOK  *bool    `json:"last_verify_ok"`
}

func (c *Client) do(method, path string, body io.Reader, contentType string) (*http.Response, error) {
	req, err := http.NewRequest(method, c.cfg.Server+path, body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if c.cfg.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	}
	req.Header.Set("User-Agent", "tapewrangler-cli/"+version)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		var e struct {
			Error string `json:"error"`
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if json.Unmarshal(raw, &e) == nil && e.Error != "" {
			return nil, &apiError{resp.StatusCode, e.Error}
		}
		return nil, &apiError{resp.StatusCode, strings.TrimSpace(resp.Status + " " + string(raw))}
	}
	return resp, nil
}

type apiError struct {
	Status  int
	Message string
}

func (e *apiError) Error() string {
	if e.Status == http.StatusUnauthorized {
		return e.Message + " (check your token: `tapewrangler login`)"
	}
	return e.Message
}

func (c *Client) getJSON(path string, out any) error {
	resp, err := c.do("GET", path, nil, "")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *Client) postJSON(path string, in, out any) error {
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	resp, err := c.do("POST", path, strings.NewReader(string(b)), "application/json")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func tapePath(barcode string) string {
	return "/api/tapes/" + url.PathEscape(barcode)
}

// UploadResult is the server's reply to a file-list upload.
type UploadResult struct {
	Tape         Tape     `json:"tape"`
	Created      bool     `json:"created"`
	Imported     int64    `json:"imported"`
	SkippedLines int      `json:"skipped_lines"`
	Errors       []string `json:"errors"`
}

// Upload sends a JSONL manifest. mode is "replace" or "append".
func (c *Client) Upload(barcode, mode, name, source string, manifest io.Reader) (*UploadResult, error) {
	q := url.Values{"mode": {mode}}
	if name != "" {
		q.Set("name", name)
	}
	if source != "" {
		q.Set("source", source)
	}
	resp, err := c.do("POST", tapePath(barcode)+"/files?"+q.Encode(), manifest, "application/x-ndjson")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var r UploadResult
	return &r, json.NewDecoder(resp.Body).Decode(&r)
}

func (c *Client) GetTape(barcode string) (*Tape, error) {
	var t Tape
	return &t, c.getJSON(tapePath(barcode), &t)
}

func (c *Client) ListTapes() ([]Tape, error) {
	var t []Tape
	return t, c.getJSON("/api/tapes", &t)
}

// TapeFiles returns the catalog's file list for a tape.
func (c *Client) TapeFiles(barcode string) ([]FileEntry, error) {
	resp, err := c.do("GET", tapePath(barcode)+"/files", nil, "")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out []FileEntry
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	for sc.Scan() {
		var e FileEntry
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			return nil, fmt.Errorf("bad line from server: %w", err)
		}
		out = append(out, e)
	}
	return out, sc.Err()
}

func (c *Client) RecordVerify(barcode string, ok bool) error {
	return c.postJSON(tapePath(barcode)+"/verify", map[string]any{"ok": ok}, nil)
}

type SearchResult struct {
	TotalFiles int64 `json:"total_files"`
	TotalBytes int64 `json:"total_bytes"`
	Tapes      []struct {
		Tape
		MatchCount int64       `json:"match_count"`
		MatchBytes int64       `json:"match_bytes"`
		Files      []FileEntry `json:"files"`
	} `json:"tapes"`
}

func (c *Client) Search(query string, perTape int) (*SearchResult, error) {
	var r SearchResult
	q := url.Values{"q": {query}, "limit": {fmt.Sprint(perTape)}}
	return &r, c.getJSON("/api/search?"+q.Encode(), &r)
}

// Ping checks the server is reachable and whether the token is accepted.
func (c *Client) Ping() (version string, tokenRequired, tokenValid bool, err error) {
	var v struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	}
	c.http.Timeout = 15 * time.Second
	defer func() { c.http.Timeout = 0 }()
	if err = c.getJSON("/api/version", &v); err != nil {
		return
	}
	var a struct {
		Required bool `json:"required"`
		Valid    bool `json:"valid"`
	}
	if err = c.getJSON("/api/auth", &a); err != nil {
		return
	}
	commit := v.Commit
	if len(commit) > 7 {
		commit = commit[:7]
	}
	return v.Version + " (" + commit + ")", a.Required, a.Valid, nil
}
