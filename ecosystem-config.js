module.exports = {
  apps: [
    {
      name: "pendingTxFeed",
      script: "pendingTransaction.js",
      cwd: "/home/ubuntu/mempool-bot",
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "botEngine",
      script: "index.js",
      cwd: "/home/ubuntu/mempool-bot",
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};