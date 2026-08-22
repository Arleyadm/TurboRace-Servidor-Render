# Turbo Race — servidor de salas

Uma sala com apenas um jogador aguarda até 5 minutos pela entrada de outra
pessoa. Com dois ou mais jogadores não há expiração por espera. Depois que
todos saem, a sala vazia é removida em 120 segundos.

Uma limpeza automática roda a cada 5 segundos. Se nenhuma ação real ocorrer
por 5 minutos, a sala é encerrada mesmo que abas antigas ainda mantenham
conexões abertas; pings técnicos não renovam esse prazo.

Servidor Node.js/WebSocket das salas online do Turbo Race. Mantém salas em
memória, aceita até 24 jogadores, sincroniza fase/semente/estado e gerencia a
ordem de chegada.

```bash
npm install
npm test
npm start
```

Endpoints HTTP: `/status` e `/salas`. WebSocket: `/corrida`.
