import http from "node:http";

const port = Number(process.env.PORT || 3333);

const server = http.createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.url === "/health") {
    response.writeHead(200);
    response.end(
      JSON.stringify({
        status: "ok",
        service: "estokar-landing-backend",
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }

  response.writeHead(404);
  response.end(
    JSON.stringify({
      message: "Rota não encontrada.",
    }),
  );
});

server.listen(port, () => {
  console.log(`Backend rodando em http://localhost:${port}`);
});
