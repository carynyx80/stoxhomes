import http from "node:http";
export function startHealth(port, getStatus) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const body = JSON.stringify(getStatus(), null, 2);
      res.writeHead(200, { "content-type": "application/json" }).end(body);
    } else res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}
