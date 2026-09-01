import Router from '@koa/router'
import { requireSuperAdmin } from '../../middleware/user-auth'
import * as ctrl from '../../controllers/hermes/media'

export const mediaRoutes = new Router()

mediaRoutes.post('/api/hermes/media/grok-image-to-video', requireSuperAdmin, ctrl.grokImageToVideo)
mediaRoutes.post('/api/hermes/media/apikey-image-generate', requireSuperAdmin, ctrl.apiKeyImageGenerate)
