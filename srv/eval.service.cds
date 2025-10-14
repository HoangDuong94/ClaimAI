using { kfz.claims as ClaimsModel } from '../db/schema';

service EvalClaimsService @(path: '/eval', impl: 'gen/srv/eval-service.js') {
  @odata.draft.enabled
  entity Claims as projection on ClaimsModel.Claims;
}

