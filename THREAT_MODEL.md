# Threat Model

Fast Hands intentionally gives an AI client powerful local execution capabilities. This document defines what the project attempts to protect and what remains outside its security boundary.

## Assets

- integrity of the operator's local workflow,
- accurate durable checkpoint state,
- non-duplication of declared external side effects after uncertain execution,
- the operator's ability to Pause or Emergency Stop work,
- privacy of local runtime state,
- predictable loopback-only network exposure by default,
- clear separation between core features and optional backends.

## Trust boundaries

### MCP client / reasoning model

The connected MCP client is allowed to request commands and workflows. Fast Hands does not treat model output as trusted in a security sense; operator controls remain available around safe points.

### Local operator

The human operator is trusted to decide when to pause, stop, revise, resume, or acknowledge an uncertain hard-stop state.

### Windows UI Direct

A configured `windows-mcp-server` is a separate process with its own behavior and guardrails. Fast Hands transports calls to it but does not claim to replace its security model.

### Web and YouTube content

Retrieved pages, search snippets, video metadata, captions, and transcripts are **untrusted data**. They may contain prompt injection or misleading instructions. Calling agents should treat retrieved content as evidence/data, not as authority to execute commands.

## Security invariants

A regression includes behavior where Fast Hands:

- binds its HTTP MCP or monitor to a non-loopback interface by default,
- loses completed-step checkpoints when an operator interrupt occurs,
- replays completed steps after `fast_revise`/`fast_resume`,
- replays a declared external mutation while its recorded outcome is `unknown`,
- allows an `operation_id` to be rebound to a different target or payload fingerprint,
- reports a hard-stopped atomic action as certainly completed,
- allows resume of an uncertain hard-stop without explicit acknowledgement,
- ignores a requested Pause at the next safe point,
- fails to terminate an active child/persistent PowerShell process after Emergency Stop,
- requires an optional backend for the core PowerShell/filesystem health check unless the operator explicitly marks that backend required,
- silently commits runtime state, screenshots, local environments, credentials, or machine-specific paths to the repository/package,
- exposes a bundled macro that depends on a private/unshipped local executable.

## Out of scope

Fast Hands is not designed to defend against:

- a malicious process running as the same Windows user that tampers with Fast Hands runtime files,
- malware, kernel compromise, privilege escalation, or hostile administrators,
- commands deliberately requested by a trusted MCP client that are destructive but valid under the current Windows permissions,
- prompt injection being solved automatically at the transport layer,
- public Internet exposure without an external authentication/TLS boundary,
- security defects inside third-party optional backends.

## External side-effect uncertainty

For steps declared with `external_effect`, Fast Hands persists an `unknown` operation record before execution. If the process crashes, times out, is hard-stopped, or otherwise fails before a definitive confirmation is durably stored, `fast_resume` refuses to replay the operation. The caller must read the remote system back and use `fast_reconcile_external` to resolve the outcome as `confirmed` or `failed`.

This mechanism protects declared external mutations only. Fast Hands cannot infer arbitrary side effects hidden inside an undeclared command.

## Hard-stop uncertainty

Emergency Stop can terminate a process during an atomic action. The action may have partially changed external state before termination. Fast Hands therefore records `needsReview: true` and requires explicit acknowledgement before retrying/resuming that uncertain step. If the step also declares `external_effect`, remote reconciliation is required before the hard-stop acknowledgement can lead to a retry.
