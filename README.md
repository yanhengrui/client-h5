# 麦穗农场 H5 联调客户端

React + TypeScript + Vite 实现的 gatesvr 联调客户端。开发服务器将 `/api` 和 `/ws` 同源代理到 gatesvr。

```powershell
cd client-h5
npm install
npm run dev
```

默认 gatesvr 地址为 `http://127.0.0.1:8080`，可通过 `VITE_GATE_PROXY` 覆盖。执行 `npm test` 运行单测，执行 `npm run build` 生成生产包。
