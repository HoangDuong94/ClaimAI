using { kfz.claims as ClaimsModel } from '../db/schema';
using from '../app/annotations';

service ClaimsService @(path: '/service/claims', impl: 'gen/srv/service.js') {

    @odata.draft.enabled
    entity Claims as projection on ClaimsModel.Claims {
        *,
        documents : redirected to ClaimDocuments
    };

    entity ClaimDocuments as projection on ClaimsModel.ClaimDocuments {
        *,
        claim : redirected to Claims
    };

    entity ClaimStatusTexts as projection on ClaimsModel.ClaimStatusTexts;

    action callLLM (prompt: String) returns { response: String };

    action triageLatestMail(
        folder   : String,
        messageId: String
    ) returns {
        summary     : String;
        category    : String;
        agentContext: LargeString;
    };
}
