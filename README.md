# Partial Update

<div align="center">
  <a href="https://www.youtube.com/watch?v=f39MnczcJZA" target="_blank">
    <img src="https://github.com/user-attachments/assets/9b1d6bb6-0e7f-40d4-bf26-4e7186a7908d" alt="Watch the video" width="800">
  </a>
</div>

<!-- <div align="center">
<img width="768" alt="martix" src="https://github.com/user-attachments/assets/6ff33272-1bb0-4551-a296-3481e243015f" />
</div> -->

A multi-user AI chat that generates its own UI on the fly. Based on the new [Dynamic Partial Update](https://developer.chrome.com/blog/declarative-partial-updates) spec.

```html
<div class="chat">
  <div class="message user">Hi I am Phil</div>
  <div class="message agent">Welcome Phil</div>
  <?marker name="append-message">
</div>
... <!-- a few seconds later -->
<template for="append-message">
  <div class="message user">What is 2 + 2?</div>
  <div class="message agent">2 + 2 = 4</div>
  <?marker name="append-message">
</template>
```

The LLM responds with HTML not markdown so the response can include SVG, CSS, JS, MathML, WebGL etc. This can be applied in various template areas.

<div align="center">
<img width="768" alt="julia2" src="https://github.com/user-attachments/assets/95ab8fb8-2451-42b5-84dd-e82d0bc69f18" />
</div>

The output can contain forms that submit their response back to the LLM. Allowing users to prompt with structured data.

<div align="center">
<img width="768" alt="name" src="https://github.com/user-attachments/assets/e128e38f-1f4e-4830-8e8d-e6062be30563" style="display: block; margin: 0 auto;" />
</div>

Forms can be styled with CSS E.g. to look like a game of Tic Tac Toe:

<div align="center">
<img width="768" alt="ttt" src="https://github.com/user-attachments/assets/51417090-17e0-4968-a2ec-3ba9dad4392d" />
</div>

The chat is multi-user so you can have play multiplayer games with a one sentence prompt:

<div align="center">
<img width="800" alt="connect4" src="https://github.com/user-attachments/assets/3b92969e-3d74-449a-9991-eeee400ea38f" />
</div>

Or have conversations where each person sees the chat in their own language:

<div align="center">
<img width="800" alt="translate" src="https://github.com/user-attachments/assets/33ccab35-1662-463c-bf50-b89d22ca39f9" />
</div>

Enabling cross-cultural communication:

<div align="center">
<img width="768" alt="image" src="https://github.com/user-attachments/assets/68801c9a-534b-42aa-9c1b-e2f34db8dd92" />
</div>

The chat can completely redesign its own interface E.g. adding voice dictation. Here I ask it to remove the prompt box and make the page look like Wikipedia. The links are forms which when submitted cause the LLM to replace the entire HTML content of the article. 

<div align="center">
<img width="768" alt="wikipedia" src="https://github.com/user-attachments/assets/4f50ce1f-cd94-415b-aa6d-d4623eb0da05" />
</div>

Because the LLM has knowledge of CDNs it can inject Tailwind, d3.js, CodeMirror or any other popular library. Here I ask it to add a CodeMirror playground so I can edit some CSS.

<div align="center">
<img width="768" alt="codemirror" src="https://github.com/user-attachments/assets/b3f2b63e-77be-4f6e-acea-34b1ddd6302b" />
</div>

The results are then submitted back to the LLM context and the CSS is made available to be used in response to further prompts.

<div align="center">
<img width="768" alt="stars" src="https://github.com/user-attachments/assets/8568aeb2-fb4c-41af-9f14-95a0ebf2726c" />
</div>

## Installation

### Warning

Until this is hardened I would recommend only running in local dev. Like Openclaw you use this at your own risk. Currently this app works best with Gemini 3.0 Flash it costs about $0.01 per prompt and Gemini seems to really get the idea of Partial Updates and forms that can edit themselves better than other models.

Two attacks a malicious prompter could make that will cost you:

1) Create clientside code that submits prompts in a tight loop (high inference cost)
2) Create clientside code loop that keeps making other requests (high cloudflare cost)

Mitigate 1 by only using with a AI API keys with limited funds e.g. $20 don't use with an expensive frontier model connected straight to your bank account. Mitigate 2 by running in local dev where there is no cost for worker requests. Normal usage for a single user should be dirt cheap to run.

### Run on your Claude Code subscription (no API keys)

This fork can run the app entirely against your local [Claude Code](https://claude.com/claude-code)
subscription instead of the Cloudflare AI Gateway — no Anthropic API token, no
Cloudflare account, no Gemini key. Everything stays on `localhost` via
`wrangler dev`.

How it works: `claude-openai-shim.mjs` is a tiny OpenAI-compatible
`/chat/completions` server that spawns the `claude` CLI behind it (billed to
your subscription because no `ANTHROPIC_API_KEY` is set) and streams its output
back in the SSE shape the app already parses. A `claude-code` model provider in
`src/index.ts` points at it.

```bash
npm install
npm run db:migrate:local          # set up the local D1 database
cp .dev.vars.example .dev.vars    # activates MODEL_PROVIDER=claude-code
./run.sh                          # boots the shim + `wrangler dev` together
# open http://localhost:8787
```

Notes:
- Requires the `claude` CLI installed and logged in (`claude` → `/login`).
- `CLAUDE_MODEL=opus ./run.sh` to pick a model (default `sonnet`).
- Local only: deployed to the Cloudflare edge the Worker can't reach your
  localhost shim. Keep it to a single local user — the same malicious-loop
  caveats above apply, and it runs against your subscription's rate limits.
- The top-level `send_email` and `ai` bindings are commented out in
  `wrangler.jsonc` so `wrangler dev` runs fully local without a Cloudflare login
  (the deployed `alpha`/`production` envs keep their own bindings).

### Cloudflare

The original hosted path, if you'd rather use the Cloudflare AI Gateway.

Requirements:

1. Signed up to Cloudflare to run this (I think free plan will be fine)  
https://dash.cloudflare.com/sign-up
2. Buy some credits in Cloudflare AI Gateway  
Search for AI Gateway click on a gateway add funds top right click the dollar amount
https://dash.cloudflare.com/YOUR_ACCOUNT_ID/ai/ai-gateway/gateways/default/overview  
<img width="241" height="125" alt="image" src="https://github.com/user-attachments/assets/1b1b0c81-081a-4854-b90a-e5cabb6ece42" />  

3. You will need the following bare minimum env vars set in .env

CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_AI_GATEWAY_ID=

Your CLOUDFLARE_ACCOUNT_ID can be found on the url once you login.

Create an API token with at least the following permissions
https://dash.cloudflare.com/YOUR_ACCOUNT_ID/api-tokens

* AI Gateway: Read, Write, Run
* Workers AI: Read, Write
* Workers Scripts: Read, Write

Paste the API key into the .env

For CLOUDFLARE_AI_GATEWAY_ID use `default` or create an new one and use that.

### Running

```bash
npm install
npm run dev
```

Open browser at the mentioned url.

<img width="680" height="189" alt="image" src="https://github.com/user-attachments/assets/8b9b1daf-e9d9-4d75-97ce-f2ba6a62d5c4" />


### dev:secure

If you do not like having your secrets in an .env file visible to your Claude, Codex AI coding agent. On Mac you can put them in your keychain

```bash
security find-generic-password -a "frontclaw" -s "CLOUDFLARE_API_TOKEN" -w
security find-generic-password -a "frontclaw" -s "CLOUDFLARE_ACCOUNT_ID" -w
security find-generic-password -a "frontclaw" -s "CLOUDFLARE_AI_GATEWAY_ID" -w
```

Then run:

```bash
npm run dev:secure
```











