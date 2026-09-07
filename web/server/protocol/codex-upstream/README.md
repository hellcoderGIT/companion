Codex protocol snapshot used by offline compatibility tests.

Source repository: `https://github.com/openai/codex`
Source commit: `0e9589ffae082437e6793e8c24900e876dfdf86a`

Copied files (stored as `.txt` snapshots to avoid TypeScript import resolution in this repo):
- `codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts` -> `ClientRequest.ts.txt`
- `codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts` -> `ServerRequest.ts.txt`
- `codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts` -> `ServerNotification.ts.txt`
- `codex-rs/app-server-protocol/schema/typescript/ClientNotification.ts` -> `ClientNotification.ts.txt`
- `codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallParams.ts` -> `v2/DynamicToolCallParams.ts.txt`
- `codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallResponse.ts` -> `v2/DynamicToolCallResponse.ts.txt`

Refresh these files with:

```bash
./scripts/sync-codex-protocol.sh
```
