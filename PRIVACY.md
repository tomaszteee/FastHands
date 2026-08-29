# Privacy

Fast Hands is designed for local operation.

## Data stored locally

The runtime directory can contain execution checkpoints, commands, paths, operator messages, event metadata, screenshots requested by the caller, research outputs, and declared external-effect records (operation IDs, targets, payload SHA-256 fingerprints, outcomes, and optional receipt/read-back metadata). `runtime/` is excluded from Git and from npm packaging.

Optional YouTube research may write transcripts, downloaded audio during local Whisper processing, and extracted frames into a caller-selected local output directory. Optional FastWeb may retrieve public web pages requested by the caller.

## Data sent externally

The core execution engine does not require a cloud API or telemetry service. Network traffic occurs only when the caller uses network-facing tools such as FastWeb, YouTubeResearch, npm/Git operations, or another explicitly configured backend.

Fast Hands does not include analytics, advertising telemetry, or a credential collection service.

## Public bug reports

Do not attach private logs, screenshots, commands, paths, credentials, tokens, transcripts, or runtime files to public issues. Use GitHub private vulnerability reporting for security-sensitive material.
