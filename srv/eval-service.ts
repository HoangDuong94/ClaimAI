import cds from '@sap/cds';

export default class EvalClaimsService extends cds.ApplicationService {
  async init() {
    await super.init();
    // Minimal service for evals: no SSE, no MCP wiring
  }
}

