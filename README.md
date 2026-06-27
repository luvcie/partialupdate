# Partial Update

<div align="center">
<img width="768" alt="martix" src="https://github.com/user-attachments/assets/6ff33272-1bb0-4551-a296-3481e243015f" />
</div>

A multi user AI chat that generates its own UI on the fly. Based on the new [Dynamic Partial Update](https://developer.chrome.com/blog/declarative-partial-updates) spec.

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

The chat is multi user so you can have play multi player games with a one sentence prompt:

<div align="center">
<img width="800" alt="connect4" src="https://github.com/user-attachments/assets/3b92969e-3d74-449a-9991-eeee400ea38f" />
</div>

Or have conversations where each person sees the chat in their own language:

<div align="center">
<img width="800" alt="translate" src="https://github.com/user-attachments/assets/33ccab35-1662-463c-bf50-b89d22ca39f9" />
</div>

Enabling cross culture communication:

<div align="center">
<img width="768" alt="image" src="https://github.com/user-attachments/assets/68801c9a-534b-42aa-9c1b-e2f34db8dd92" />
</div>

The chat can completely redesign its own interface E.g. adding voice dictation. Here I ask it to remove the prompt box and make the page look like Wikipedia. The links are forms which when submited cause the LLM to replace the entire HTML content of the article. 

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

Until this is hardened I would recommend only running in local dev. Like Openclaw you use this at your own risk. Currently this app works best with Gemini 3.0 Flash it costs about $0.01 per prompt and Gemini seems to really get the idea of Partial Updates and forms that can edit themselves better than other models.

Two attacks a malicious prompter could make that will cost you:

1) Create clientside code that submits prompts in a tight loop (high inference cost)
2) Create clientside code loop that keeps makeing other requests (high cloudflare cost)

Mitigate 1 by only using with a AI API keys with limited funds e.g. $20 don't use with an expensive frontier model connected straight to your bank account. Mitigate 2 by running in local dev where there is no cost for worker requests. Normal usage for a single user should be dirt cheap to run. 



