import { createApp } from '~/app'

const app = createApp({ logRequests: true }).listen(3000)

console.log(`fileslop is listening on ${app.server?.url}`)
