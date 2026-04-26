// Package analytics provides the Go HTTP handler for the analytics ingest path.
package analytics

import (
	"encoding/json"
	"net/http"
)

// Event represents an inbound analytics event payload.
type Event struct {
	Name       string                 `json:"name"`
	Properties map[string]interface{} `json:"properties"`
}

// IngestHandler handles POST /ingest requests from the TypeScript client.
func IngestHandler(w http.ResponseWriter, r *http.Request) {
	var evt Event
	if err := json.NewDecoder(r.Body).Decode(&evt); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// TODO: forward to storage
	w.WriteHeader(http.StatusAccepted)
}
