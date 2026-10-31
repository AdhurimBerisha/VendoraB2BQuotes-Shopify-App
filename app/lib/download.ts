// Browser downloads from embedded pages. A plain link to an app URL has no session token;
// App Bridge adds it to fetch, so files are fetched and saved from a blob.

const saveBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

// Fetches an app URL (resource route) and saves the response. Throws if the server said no.
const downloadFrom = async (url: string, fileName: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  saveBlob(await response.blob(), fileName);
};

// Saves text we already have (CSV reports, templates).
const downloadText = (text: string, fileName: string) =>
  saveBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), fileName);

export { downloadFrom, downloadText };
