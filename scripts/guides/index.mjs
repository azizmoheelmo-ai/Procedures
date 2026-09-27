// Registry of guides the hub can import.
//
// Most new guides follow the generic tree template (see
// docs/extraction-standard.md) and need only a data file plus one line here:
//   genericGuide({ code: 'behavior_regs', source: 'data/behavior_regs.json' })
//
// A guide whose structure doesn't fit that template gets its own adapter
// next to these (see payload.mjs for the payload format) and is listed here
// instead.
import procedures from './procedures.mjs';
import orgManual from './org-manual.mjs';
import { genericGuide } from './generic.mjs';

export { genericGuide };
export const guides = [procedures, orgManual];
