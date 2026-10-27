# help-app

Prescaffolded Next.js help app, copied by `aida init`. Content comes from the AIDA engine (the
`aida-docs` package, `packages/engine`); keep this app thin — logic belongs in the engine, routes
here just call it.

## Help chat widget

Help chat answers only from this site's own docs, with citations, and knows which screen a
reader is on when embedded inside the app it documents (see `docs/scope.md` "Help chat").

### React component

For an app that already uses React:

```tsx
import { ChatWidget } from "help-app/components/chat/ChatWidget"; // or copy the file in — it has no server-only imports

<ChatWidget apiBase="https://your-help-site.example.com/api/chat" />
```

`apiBase` defaults to `/api/chat` (same-origin — the help site's own pages already render this
component). Pass the help site's full origin when using the component from a different app.

### Drop-in script tag

For any app, React or not:

```html
<script src="https://your-help-site.example.com/widget.js" data-help-url="https://your-help-site.example.com"></script>
```

Either way, `chat.allowedOrigins` in `aida.config.ts` must list the app's own origin — `/api/chat`
applies CORS only to configured origins (`docs/scope.md` "Help chat": "Cross-origin: chat route
allows CORS only from configured app origins").

## Agent connector (MCP server)

`/api/mcp` mounts a read-only [Model Context Protocol](https://modelcontextprotocol.io) server
(Streamable HTTP transport) with five tools: `get_app_overview` (from the app brief, when there is
one), `search_docs`, `get_page`, `list_walkthroughs`, `get_procedure`. Point any MCP client at `https://your-help-site.example.com/api/mcp`.

## Without an API key

Chat needs `ANTHROPIC_API_KEY` set on whatever host runs this app (the owner's own key — see
`docs/decisions.md` #40). Without it, `/api/chat` answers `503` and the rest of the site,
including search and the MCP server, is unaffected.
