/// <reference types="vite/client" />
import type { DesktopApi } from './types/api'
declare global { interface Window { prime: DesktopApi } }
