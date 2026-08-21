# Turbo Race — servidor de salas

Servidor Node.js/WebSocket das salas online do Turbo Race. Mantém salas em
memória, aceita até 8 jogadores, sincroniza fase/semente/estado e gerencia a
ordem de chegada.

```bash
npm install
npm test
npm start
```

Endpoints HTTP: `/status` e `/salas`. WebSocket: `/corrida`.
