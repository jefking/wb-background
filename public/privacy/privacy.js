import { MemoryVault, VaultProvider } from "/vault-sdk/index.js";

const vault = new MemoryVault();
const status = document.querySelector("#connection-status");
const keyInput = document.querySelector("#secret-key");
const valueInput = document.querySelector("#secret-value");
const saveButton = document.querySelector("#save-secret");
const editorMessage = document.querySelector("#editor-message");
const keyList = document.querySelector("#key-list");
const keyCount = document.querySelector("#key-count");

const provider = new VaultProvider({
  vault,
  trustedHostOrigin: "http://127.0.0.1:8000",
  onConnectionChange({ connected }) {
    status.textContent = connected ? "Broker connected" : "Waiting for broker";
    status.className = connected ? "status ready" : "status waiting";
  }
});

function showEditorMessage(message, isError = false) {
  editorMessage.textContent = message;
  editorMessage.classList.toggle("error", isError);
}

function saveSecret() {
  try {
    const { key } = vault.save(keyInput.value, valueInput.value);
    valueInput.value = "";
    showEditorMessage(`Saved “${key}” in this page’s memory.`);
  } catch (error) {
    showEditorMessage(error.message, true);
  }
}

function deleteSecret(key) {
  if (!vault.delete(key)) return;
  showEditorMessage(`Deleted “${key}”. Any grant was invalidated.`);
}

function renderKeys() {
  const entries = vault.catalog();
  keyCount.textContent = String(entries.length);
  keyList.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No secrets are stored.";
    keyList.append(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "key-row";
    const label = document.createElement("div");
    const keyName = document.createElement("code");
    keyName.textContent = entry.key;
    const revision = document.createElement("span");
    revision.className = "key-meta";
    revision.textContent = `revision ${entry.revision}`;
    label.append(keyName, revision);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deleteSecret(entry.key));
    row.append(label, remove);
    keyList.append(row);
  }
}

saveButton.addEventListener("click", saveSecret);
valueInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveSecret();
});
vault.subscribe(renderKeys);
provider.listen();
renderKeys();
