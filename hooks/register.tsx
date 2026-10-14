import type { Register } from 'claude-code'

import { registerHouston } from './houston'

export const register: Register = on => {
  registerHouston(on)
}
