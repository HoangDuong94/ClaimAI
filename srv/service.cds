using { kfz.claims as ClaimsModel } from '../db/schema';
using from '../app/annotations';

service ClaimsService @(path: '/service/claims', impl: 'gen/srv/service.js') {

    // Structured UI resource to transport MCP-UI content via OData
    type UIResource {
        uri      : String;
        mimeType : String;
        text     : LargeString; // rawHtml or external URL, depending on mimeType
    };

    @odata.draft.enabled
    entity Claims as projection on ClaimsModel.Claims {
        *,
        documents   : redirected to ClaimDocuments,
        attachments : redirected to Attachments
    } actions {
        // Bound variant: Persist a local file and link to the bound claim (draft-aware)
        action uploadLocalFileToClaim (path : String, note : String) returns UUID;
    };

    entity ClaimDocuments as projection on ClaimsModel.ClaimDocuments {
        *,
        claim : redirected to Claims
    };

    entity ClaimStatusTexts as projection on ClaimsModel.ClaimStatusTexts;

    // Binary attachments and Excel import jobs
    entity Attachments as projection on ClaimsModel.Attachments;
    entity ExcelImports as projection on ClaimsModel.ExcelImports;

    action callLLM (
        prompt: String,
        sessionId: String
    ) returns { response: String; uiResource: UIResource; };

    action triageLatestMail(
        folder   : String,
        messageId: String
    ) returns {
        summary     : String;
        category    : String;
        agentContext: LargeString;
    };

    // Persist a local file from the tmp/ folder as attachment
    action uploadLocalFile(
        path : String,
        note : String,
        claimId : UUID
    ) returns UUID;


    // Queue an excel import for a given attachment (no parsing yet)
    action importExcel(
        fileId : UUID,
        target : String
    ) returns UUID;
}
