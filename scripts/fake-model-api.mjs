#!/usr/bin/env node
/**
 * A stand-in for a model's API, for testing `scenescout ci` and its GitHub
 * Action with no network and no real key. It answers POST /v1/responses the
 * way the OpenAI Responses API does, with a scripted model: the first turn
 * asks for scout_crawl, the next ends the run. Its final reply quotes the key
 * it was sent, as some APIs' error messages do, so a test can check the run
 * never prints it.
 *
 *   EXPECTED_KEY=dummy node scripts/fake-model-api.mjs 4180
 *
 * A request without `Authorization: Bearer $EXPECTED_KEY` gets a 401.
 */
import http from "node:http";

const port = Number(process.argv[2] ?? 4180);
const expected = process.env.EXPECTED_KEY ?? "";
if (!expected) {
  console.error("fake-model-api: set EXPECTED_KEY");
  process.exit(2);
}

const usage = (input) => ({ input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20 });

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/v1/responses") return reply(404, { error: { message: `no route ${req.method} ${req.url}` } });
    if (req.headers.authorization !== `Bearer ${expected}`) return reply(401, { error: { message: "Incorrect API key provided" } });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { error: { message: "the body is not JSON" } });
    }
    const answered = (body.input ?? []).filter((i) => i && i.type === "function_call_output").length;
    if (answered === 0) {
      return reply(200, {
        status: "completed",
        output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "scout_crawl", arguments: "{}" }],
        usage: usage(1000),
      });
    }
    return reply(200, {
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: `Explored the app. (Sent with key ${expected}.)` }] }],
      usage: usage(2000),
    });
  });
});
server.listen(port, "127.0.0.1", () => console.log(`fake model API on http://127.0.0.1:${port}/v1`));
