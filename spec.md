This is a V2 migration of frontclaw with a slightly different architecture.

1. Rather than keeping the initial stream open we close it.
2. Updates from the server happen via websockets from the DO. We use Cloudflare hibernatable WS and automatic ping/pong.
3. We continue to use form submission to a hidden iframe.
4. We keep the debug view so we can see message history in the format the LLM uses.

## Message Format

LLM responses use a delimiter-based protocol instead of NDJSON. This keeps HTML readable and avoids JSON string escaping mistakes.

Multiple messages in one turn are split by this delimiter on its own line:

```text
PpqUtcLGQdYN4oqc:SPLIT_MESSAGE
```

Each message has optional server props, optional client props, and a required body:

```text
PpqUtcLGQdYN4oqc:SERVER_PROPS_START
{
  clients: {
    type: 'exclude',
    ids: []
  }
}
PpqUtcLGQdYN4oqc:SERVER_PROPS_END
PpqUtcLGQdYN4oqc:CLIENT_PROPS_START
{
  path: '/body',
  type: 'html'
}
PpqUtcLGQdYN4oqc:CLIENT_PROPS_END
PpqUtcLGQdYN4oqc:BODY_START
<template for="/chat/append-message">...</template>
PpqUtcLGQdYN4oqc:BODY_END
```

If `SERVER_PROPS` is omitted, the message is sent to all clients.
If `CLIENT_PROPS` is omitted, the browser receives `{ path: '/body', type: 'html' }`.

`SERVER_PROPS` route messages and are not sent to the browser:

```js
{
  clients: {
    type: 'include' | 'exclude',
    ids: ['client id']
  }
}
```

`CLIENT_PROPS` are visible to the browser:

```js
{
  path: '/app/counter/1',
  type: 'json'
}
```

The body is sent as a string payload without JSON escaping. Server replacements are applied per receiving client:

```text
PpqUtcLGQdYN4oqc:CLIENT_ID
PpqUtcLGQdYN4oqc:CHAT_ID
```

## Events

Events coming from the server are available on the client to be subscribed to. Server props are stripped before dispatch.

```js
const unsubscribe = window.partialupdates.subscribe(
  new Subscription(
    (x) => x.path === "/body" && x.type === "html",
    (e) => {
      document.body.insertAdjacentHTML("beforeend", e.payload);
    },
  ),
);
```

Template markers use path-like names such as `/chat/append-message` and `/app/tictactoe/1`.

## Wrangler

We need pretty much the same structure in wrangler and package.json but with the name partialupdate. Reuse the same code for LLM selection, secrets and settings.
