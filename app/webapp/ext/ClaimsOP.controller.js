sap.ui.define([
  "sap/fe/core/PageController",
  "sap/m/MessageToast"
], function (PageController, MessageToast) {
  "use strict";

  return PageController.extend("kfz.claims.ui.app.ext.ClaimsOP", {
    onUploadAttachment: function () {
      const view = this.getView();
      const ctx = view.getBindingContext();
      if (!ctx) {
        MessageToast.show("Kein Kontext verfügbar");
        return;
      }
      const data = ctx.getObject();
      if (!data || data.IsActiveEntity) {
        MessageToast.show("Bitte Entwurf bearbeiten, dann hochladen.");
        return;
      }
      const claimId = data.ID;
      const model = view.getModel();
      // determine service root
      const serviceUrl = model && model.sServiceUrl ? model.sServiceUrl.replace(/\/$/, "") : "/service/claims";

      const input = document.createElement("input");
      input.type = "file";
      input.onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          view.setBusy(true);
          // 1) Create attachment under draft claim
          const createUrl = `${serviceUrl}/Claims(ID=${claimId},IsActiveEntity=false)/attachments`;
          const createRes = await fetch(createUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "accept": "application/json" },
            body: JSON.stringify({ fileName: file.name, mediaType: file.type || "application/octet-stream" })
          });
          if (!createRes.ok) throw new Error(`CREATE attachment failed: ${createRes.status}`);
          const created = await createRes.json();
          const attId = created && (created.ID || created.id || created.value || created.d?.ID);
          if (!attId) throw new Error("Attachment ID fehlt nach CREATE");

          // 2) Upload content stream
          const putUrl = `${serviceUrl}/Attachments(ID=${attId},IsActiveEntity=false)/content/$value`;
          const putRes = await fetch(putUrl, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
          if (!putRes.ok) throw new Error(`PUT content failed: ${putRes.status}`);

          // 3) Refresh page to reflect new attachment
          const extApi = this.getExtensionAPI && this.getExtensionAPI();
          if (extApi && extApi.refresh) {
            await extApi.refresh();
          } else {
            model.refresh && model.refresh();
          }
          MessageToast.show("Anhang hochgeladen");
        } catch (err) {
          MessageToast.show(err && err.message ? err.message : String(err));
        } finally {
          view.setBusy(false);
        }
      };
      input.click();
    }
  });
});

