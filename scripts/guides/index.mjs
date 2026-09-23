// Registry of guides the hub can import. To add a guide: write an adapter
// next to these (see payload.mjs for the payload format) and list it here.
import procedures from './procedures.mjs';
import orgManual from './org-manual.mjs';

export const guides = [procedures, orgManual];
