// infra/firecracker/guest/cmd/agent/main.go
// Guest agent binary — runs inside the Firecracker rootfs.
// Listens on vsock CID=3 PORT=52 for script execution requests from the host.
// Protocol: newline-delimited JSON over vsock.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"syscall"
	"time"
)

const (
	vsockPort = 52
	vsockCID  = syscall.VMADDR_CID_ANY
)

type ExecuteRequest struct {
	Script  string `json:"script"`
	Runtime string `json:"runtime"` // "node", "python3", "bash"
	TimeoutMs int  `json:"timeoutMs"`
}

type ExecuteResponse struct {
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	ExitCode  int    `json:"exitCode"`
	DurationMs int64 `json:"durationMs"`
	Error     string `json:"error,omitempty"`
}

func handleConn(conn net.Conn) {
	defer conn.Close()
	scanner := bufio.NewScanner(conn)
	encoder := json.NewEncoder(conn)

	for scanner.Scan() {
		var req ExecuteRequest
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			_ = encoder.Encode(ExecuteResponse{Error: fmt.Sprintf("invalid request: %v", err)})
			continue
		}

		if req.TimeoutMs <= 0 {
			req.TimeoutMs = 10_000
		}

		resp := execute(req)
		if err := encoder.Encode(resp); err != nil {
			log.Printf("failed to write response: %v", err)
			return
		}
	}
}

func execute(req ExecuteRequest) ExecuteResponse {
	start := time.Now()

	var cmd *exec.Cmd
	switch req.Runtime {
	case "node":
		cmd = exec.Command("node", "-e", req.Script)
	case "python3":
		cmd = exec.Command("python3", "-c", req.Script)
	case "bash":
		cmd = exec.Command("bash", "-c", req.Script)
	default:
		return ExecuteResponse{Error: fmt.Sprintf("unknown runtime: %s", req.Runtime)}
	}

	// Capture output
	var stdout, stderr bufio.Writer
	outBuf := &limitedWriter{max: 1 << 20} // 1 MiB cap
	errBuf := &limitedWriter{max: 256 << 10}
	_ = stdout
	_ = stderr
	cmd.Stdout = outBuf
	cmd.Stderr = errBuf

	// Timeout via timer
	done := make(chan error, 1)
	go func() { done <- cmd.Run() }()

	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	select {
	case err := <-done:
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = 1
			}
		}
		return ExecuteResponse{
			Stdout:     outBuf.String(),
			Stderr:     errBuf.String(),
			ExitCode:   exitCode,
			DurationMs: time.Since(start).Milliseconds(),
		}
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		return ExecuteResponse{
			Stdout:     outBuf.String(),
			Stderr:     errBuf.String(),
			ExitCode:   124, // convention: timeout exit code
			DurationMs: time.Since(start).Milliseconds(),
			Error:      "execution timed out",
		}
	}
}

type limitedWriter struct {
	buf []byte
	max int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	remaining := w.max - len(w.buf)
	if remaining <= 0 {
		return len(p), nil
	}
	if len(p) > remaining {
		p = p[:remaining]
	}
	w.buf = append(w.buf, p...)
	return len(p), nil
}

func (w *limitedWriter) String() string {
	return string(w.buf)
}

func main() {
	log.SetPrefix("[guest-agent] ")

	// Listen on vsock
	ln, err := net.Listen("vsock", fmt.Sprintf(":%d", vsockPort))
	if err != nil {
		// Fallback to TCP socket for local testing (non-VM environments)
		var tcpErr error
		ln, tcpErr = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", vsockPort))
		if tcpErr != nil {
			log.Fatalf("failed to listen on vsock or TCP: vsock=%v tcp=%v", err, tcpErr)
		}
		log.Printf("vsock unavailable — listening on TCP :%d (non-VM mode)", vsockPort)
	} else {
		log.Printf("listening on vsock CID=%d PORT=%d", vsockCID, vsockPort)
	}

	_ = os.Stdout
	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("accept error: %v", err)
			continue
		}
		go handleConn(conn)
	}
}
