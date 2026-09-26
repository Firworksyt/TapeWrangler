package main

// Configuration: where the server is and the token for it.
//
// Each setting is taken from the first place that has it:
//   1. a command-line flag (--server, --token)
//   2. an environment variable (TAPEWRANGLER_SERVER, TAPEWRANGLER_TOKEN)
//   3. the config file, written by `tapewrangler login`:
//        Linux:   ~/.config/tapewrangler/config.toml
//        macOS:   ~/Library/Application Support/tapewrangler/config.toml
//        Windows: %AppData%\tapewrangler\config.toml
//
// The file uses a tiny subset of TOML: `key = "value"` lines and # comments.

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	Server string
	Token  string
}

func configDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "tapewrangler"), nil
}

func configPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.toml"), nil
}

func readConfigFile() (Config, error) {
	var c Config
	p, err := configPath()
	if err != nil {
		return c, err
	}
	f, err := os.Open(p)
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		if uq, err := strconv.Unquote(val); err == nil {
			val = uq
		}
		switch key {
		case "server":
			c.Server = val
		case "token":
			c.Token = val
		}
	}
	return c, sc.Err()
}

func writeConfigFile(c Config) (string, error) {
	p, err := configPath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return "", err
	}
	body := fmt.Sprintf("# Written by `tapewrangler login`.\nserver = %q\ntoken  = %q\n", c.Server, c.Token)
	// 0600: the token lives here.
	return p, os.WriteFile(p, []byte(body), 0o600)
}

// resolveConfig merges flag values over the environment over the file.
func resolveConfig(flagServer, flagToken string) (Config, error) {
	c, err := readConfigFile()
	if err != nil {
		return c, fmt.Errorf("reading config: %w", err)
	}
	if v := os.Getenv("TAPEWRANGLER_SERVER"); v != "" {
		c.Server = v
	}
	if v := os.Getenv("TAPEWRANGLER_TOKEN"); v != "" {
		c.Token = v
	}
	if flagServer != "" {
		c.Server = flagServer
	}
	if flagToken != "" {
		c.Token = flagToken
	}
	c.Server = strings.TrimRight(c.Server, "/")
	return c, nil
}

func (c Config) requireServer() error {
	if c.Server == "" {
		return fmt.Errorf("no server configured: run `tapewrangler login <url>`, set TAPEWRANGLER_SERVER, or pass --server")
	}
	return nil
}
