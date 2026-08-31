import { start } from '~/start'

const app = (await start()).listen(3000)

console.log(`fileslop is listening on ${app.server?.url}`)
