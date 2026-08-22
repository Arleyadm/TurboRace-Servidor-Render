# Turbo Race — servidor de salas

Uma sala com apenas um jogador aguarda até 5 minutos pela entrada de outra
pessoa. Com dois ou mais jogadores não há expiração por espera. Depois que
todos saem, a sala vazia é removida em 120 segundos.

Uma limpeza automática roda a cada 5 segundos. Se nenhuma ação real ocorrer
por 5 minutos, a sala é encerrada mesmo que abas antigas ainda mantenham
conexões abertas; pings técnicos não renovam esse prazo.

A largada usa uma barreira de carregamento: primeiro o servidor manda todos
prepararem a pista, espera cada PC/celular confirmar `carregado` e só então
libera uma contagem sincronizada de 4,5 segundos. Estados enviados antes dessa
liberação são ignorados, evitando vantagem de volta/posição para o anfitrião.
O campo legado de 3 segundos continua disponível.

Servidor Node.js/WebSocket das salas online do Turbo Race. Mantém salas em
memória, aceita até 24 jogadores, sincroniza fase/semente/estado e gerencia a
ordem de chegada.

```bash
npm install
npm test
npm start
```

Endpoints HTTP: `/status` e `/salas`. WebSocket: `/corrida`.
