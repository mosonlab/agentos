import { templatePromptGenerationDigest } from "../src/canonical-template-transition.js";
import { loadAllTemplateStepSources } from "../src/template-sources.js";

const sources = await loadAllTemplateStepSources();
const digests = Object.fromEntries([...sources].map(([name, steps]) => [
  name,
  templatePromptGenerationDigest(steps),
]));

console.log(JSON.stringify(digests, null, 2));
