"""
ForgeOS — official Python SDK.

Dependency-free: uses only the standard library, so it drops into any
environment without a resolver fight. The design mirrors the TypeScript client
so that examples translate between the two without surprises.

    from forgeos import ForgeOS

    forge = ForgeOS(base_url="http://localhost:3000", api_key="fk_...")
    project = forge.create_project(name="my-service", source="/srv/my-service")
    summary = forge.analyze_project(project["id"])
    print(summary["healthScore"], summary["grade"])
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterator, List, Optional, Sequence

__version__ = "0.1.0"
__all__ = ["ForgeOS", "ForgeAPIError"]


class ForgeAPIError(Exception):
    """Raised when the API returns a non-2xx response."""

    def __init__(self, status: int, code: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details or {}

    @property
    def retryable(self) -> bool:
        """True when retrying the identical request could plausibly succeed."""
        return self.status == 429 or self.status >= 500

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"ForgeAPIError(status={self.status}, code={self.code!r}, message={str(self)!r})"


class ForgeOS:
    """Client for a ForgeOS instance."""

    def __init__(
        self,
        base_url: str = "http://localhost:3000",
        api_key: Optional[str] = None,
        workspace_id: Optional[str] = None,
        timeout: float = 60.0,
        retries: int = 2,
        headers: Optional[Dict[str, str]] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.workspace_id = workspace_id
        self.timeout = timeout
        self.retries = retries
        self.headers = headers or {}

    # -- internals ---------------------------------------------------------

    def _headers(self) -> Dict[str, str]:
        headers = {"content-type": "application/json", "accept": "application/json"}
        headers.update(self.headers)
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        if self.workspace_id:
            headers["x-forgeos-workspace"] = self.workspace_id
        return headers

    def _request(
        self,
        method: str,
        path: str,
        query: Optional[Dict[str, Any]] = None,
        body: Any = None,
    ) -> Any:
        url = f"{self.base_url}/api{path}"
        if query:
            filtered = {k: v for k, v in query.items() if v is not None}
            if filtered:
                url += "?" + urllib.parse.urlencode(filtered, doseq=True)

        data = json.dumps(body).encode("utf-8") if body is not None else None
        last_error: Optional[ForgeAPIError] = None

        for attempt in range(self.retries + 1):
            request = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = response.read().decode("utf-8")
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as error:
                raw = error.read().decode("utf-8")
                try:
                    parsed = json.loads(raw) if raw else {}
                except json.JSONDecodeError:
                    parsed = {}
                envelope = parsed.get("error", {}) if isinstance(parsed, dict) else {}
                last_error = ForgeAPIError(
                    error.code,
                    envelope.get("code", "unknown"),
                    envelope.get("message", f"{method} {path} failed with {error.code}"),
                    envelope.get("details"),
                )
                if not last_error.retryable or attempt == self.retries:
                    raise last_error from error
            except urllib.error.URLError as error:
                last_error = ForgeAPIError(0, "network_error", str(error.reason))
                if attempt == self.retries:
                    raise last_error from error

            # Exponential backoff, capped. Hammering a rate limit only extends it.
            time.sleep(min(4.0, 0.25 * (2**attempt)))

        raise last_error or ForgeAPIError(0, "unknown", "Request failed")

    # -- system ------------------------------------------------------------

    def health(self) -> Dict[str, Any]:
        """Instance status, active storage backend and registered AI providers."""
        return self._request("GET", "/system/health")

    # -- projects ----------------------------------------------------------

    def list_projects(self, limit: int = 50, offset: int = 0) -> Dict[str, Any]:
        return self._request("GET", "/projects", query={"limit": limit, "offset": offset})

    def get_project(self, project_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/projects/{urllib.parse.quote(project_id)}")

    def create_project(self, name: str, source: str, description: Optional[str] = None) -> Dict[str, Any]:
        return self._request(
            "POST", "/projects", body={"name": name, "source": source, "description": description}
        )

    def delete_project(self, project_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/projects/{urllib.parse.quote(project_id)}")

    def analyze_project(self, project_id: str) -> Dict[str, Any]:
        """Run a full analysis. Returns the summary, not the full report."""
        return self._request("POST", f"/projects/{urllib.parse.quote(project_id)}/analyze")

    def get_analysis(self, project_id: str) -> Dict[str, Any]:
        """The complete analysis: metrics, graph, hotspots, debt, API, schema."""
        return self._request("GET", f"/projects/{urllib.parse.quote(project_id)}/analysis")

    # -- documentation -----------------------------------------------------

    def generate_docs(self, project_id: str, kinds: Optional[Sequence[str]] = None) -> Dict[str, Any]:
        return self._request(
            "POST", "/docs/generate", body={"projectId": project_id, "kinds": list(kinds) if kinds else None}
        )

    def list_documents(self, project_id: Optional[str] = None, limit: int = 50) -> Dict[str, Any]:
        return self._request("GET", "/docs", query={"projectId": project_id, "limit": limit})

    # -- security ----------------------------------------------------------

    def scan_project(self, project_id: str) -> Dict[str, Any]:
        """Secrets, insecure patterns and vulnerable dependencies."""
        return self._request("POST", "/security/scan", body={"projectId": project_id})

    # -- search and memory -------------------------------------------------

    def search(self, query: str, kinds: Optional[Sequence[str]] = None, limit: int = 20) -> Dict[str, Any]:
        return self._request(
            "GET",
            "/search",
            query={"q": query, "limit": limit, "kinds": ",".join(kinds) if kinds else None},
        )

    def remember(
        self,
        content: str,
        kind: str = "fact",
        tags: Optional[Sequence[str]] = None,
    ) -> Dict[str, Any]:
        return self._request(
            "POST", "/memory", body={"content": content, "kind": kind, "tags": list(tags) if tags else []}
        )

    def recall(self, query: str, limit: int = 8) -> Dict[str, Any]:
        return self._request("GET", "/memory", query={"q": query, "limit": limit})

    # -- assistant ---------------------------------------------------------

    def ask(
        self,
        message: str,
        conversation_id: Optional[str] = None,
        project_id: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self._request(
            "POST",
            "/assistant",
            body={
                "message": message,
                "conversationId": conversation_id,
                "projectId": project_id,
                "model": model,
            },
        )

    def ask_stream(
        self,
        message: str,
        conversation_id: Optional[str] = None,
        project_id: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Iterator[str]:
        """Yield answer fragments as the server produces them."""
        url = f"{self.base_url}/api/assistant/stream"
        payload = json.dumps(
            {
                "message": message,
                "conversationId": conversation_id,
                "projectId": project_id,
                "model": model,
            }
        ).encode("utf-8")
        request = urllib.request.Request(url, data=payload, headers=self._headers(), method="POST")

        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line.startswith("data:"):
                    continue
                body = line[5:].strip()
                if not body or body == "[DONE]":
                    continue
                try:
                    event = json.loads(body)
                except json.JSONDecodeError:
                    continue
                delta = event.get("delta")
                if delta:
                    yield delta

    # -- workflows, specs, benchmarks --------------------------------------

    def list_workflows(self) -> Dict[str, Any]:
        return self._request("GET", "/workflows")

    def run_workflow(self, workflow_id: str, payload: Any = None) -> Dict[str, Any]:
        return self._request(
            "POST", f"/workflows/{urllib.parse.quote(workflow_id)}/run", body={"input": payload}
        )

    def list_specs(self) -> Dict[str, Any]:
        return self._request("GET", "/specs")

    def generate_sdk(self, spec_id: str, language: str = "python") -> Dict[str, Any]:
        return self._request(
            "POST", f"/specs/{urllib.parse.quote(spec_id)}/sdk", body={"language": language}
        )

    def list_benchmarks(self) -> Dict[str, Any]:
        return self._request("GET", "/benchmarks")

    def run_benchmark(self, config: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("POST", "/benchmarks", body=config)

    # -- convenience -------------------------------------------------------

    def workspaces(self) -> List[Dict[str, Any]]:
        result = self._request("GET", "/workspaces")
        return result.get("items", []) if isinstance(result, dict) else []

    def with_workspace(self, workspace_id: str) -> "ForgeOS":
        """A copy of this client scoped to another workspace."""
        return ForgeOS(
            base_url=self.base_url,
            api_key=self.api_key,
            workspace_id=workspace_id,
            timeout=self.timeout,
            retries=self.retries,
            headers=dict(self.headers),
        )
