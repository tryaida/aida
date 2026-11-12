# Help app

This folder is your help site: a Next.js app that `aida init` set up and `aida build` keeps
filled. The pages, the help chat (`/api/chat`), the agent connector (`/api/mcp`) and the Studio
(`/studio`, dev only) are routes in it. The work is done by the `aida-docs` package it depends
on, so keep this app thin: change your guides through the walkthroughs, not the generated pages.

- `walkthroughs/`: one file per walkthrough, the source of every page, video and PDF.
- `aida.config.ts`: your app's address, brand, help chat and other settings.
- `content/docs/`, and in `public/` the videos, PDFs, screenshots, search index and `llms.txt`:
  written by `aida build`, so edits there are replaced on the next build.
- `app/`, `components/`, `lib/`: the site itself. After updating AIDA, `aida upgrade` brings in
  the new version and leaves files you changed alone; see
  [Upgrade the help app](https://github.com/tryaida/aida/blob/main/docs/setup.md#upgrade-the-help-app).

Setup and every command: [docs/setup.md](https://github.com/tryaida/aida/blob/main/docs/setup.md)
in the AIDA repository.

## Help inside your app

The help widget puts your guides inside the app they document and needs no API key: add one
script tag to the app's pages.

```html
<script src="https://your-help-site.example.com/widget.js" data-help-url="https://your-help-site.example.com"></script>
```

It shows the guides for the screen the reader is on, searches every guide, and offers the help
chat when the chat is set up (below). Details, including apps served under a path and static
hosts: [In-app help](https://github.com/tryaida/aida/blob/main/docs/setup.md#in-app-help).

### React component

The help site's own pages use the chat component in `components/chat/ChatWidget.tsx` (with
`components/chat/markdown.tsx`, which it imports). Neither has server-only imports, so a React
app can copy both files in:

```tsx
import { ChatWidget } from "./ChatWidget";

<ChatWidget apiBase="https://your-help-site.example.com/api/chat" />
```

`apiBase` defaults to `/api/chat` (the help site's own origin). Pass the help site's full origin
when using the component from a different app. It's styled with Tailwind classes and the help
site's theme variables, so in an app without them the script tag above looks better.

### Help chat

The help chat answers only from this site's own guides, with citations, and inside your app it
knows which screen the reader is on. It needs `ANTHROPIC_API_KEY` set on whatever host runs this
app: your own key, never committed to the repository. Without it, `/api/chat` answers `503`, the
chat stays hidden, and the rest of the site, including search, the widget's guides and the agent
connector, works as usual.

To use the chat from your app (the script tag or the component), list the app's own origin in
`chat.allowedOrigins` in `aida.config.ts`: `/api/chat` allows cross-origin requests only from
those origins.

## Agent connector (MCP server)

`/api/mcp` is a read-only [Model Context Protocol](https://modelcontextprotocol.io) server
(Streamable HTTP transport) with five tools: `get_app_overview` (from the app brief, when there is
one), `search_docs`, `get_page`, `list_walkthroughs` and `get_procedure`. Point any MCP client at
`https://your-help-site.example.com/api/mcp`.
