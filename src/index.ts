import { createApp } from '~/app'

const app = createApp().listen(3000)

console.log(`fileslop is listening on ${app.server?.url}`)
