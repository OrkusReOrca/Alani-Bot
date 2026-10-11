// The `.at` command as the bot registers it: the command from command.js built
// with the real dependencies (runtime.js). Tests import command.js directly.

import { createExecute, data, aiGuide, isDestructive } from "./command.js";
import { defaultDeps } from "./runtime.js";

export { data, aiGuide, isDestructive };
export const execute = createExecute(defaultDeps);
