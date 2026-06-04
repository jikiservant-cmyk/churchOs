import AdmZip from 'adm-zip';

const zip = new AdmZip('churchos-livepay-fix.zip');
zip.getEntries().forEach((entry) => {
  console.log(entry.entryName);
  console.log(zip.readAsText(entry));
});
