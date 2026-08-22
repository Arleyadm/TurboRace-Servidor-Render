# Turbo Race — servidor de salas

Salas em espera com zero ou apenas um jogador são encerradas automaticamente
depois de 2 minutos. A contagem é cancelada assim que um segundo jogador entra
e reinicia caso a sala volte a ficar com somente um jogador.

Servidor Node.js/WebSocket das salas online do Turbo Race. Mantém salas em
memória, aceita até 24 jogadores, sincroniza fase/semente/estado e gerencia a
ordem de chegada.

```bash
npm install
npm test
npm start
```

Endpoints HTTP: `/status` e `/salas`. WebSocket: `/corrida`.
