import { render } from './render.js';

/**
 * LANDMINE. The seed lives in the API. This screen does not load it.
 * A passing `render()` test does not mean the seed is visible.
 */
export function App(): string {
  return render();
}
