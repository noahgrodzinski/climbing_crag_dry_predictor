# Report collection (Google Sheet)

Condition reports from the site go into a Google Sheet that you own. One-off setup, about 5 minutes:

1. Create a new Google Sheet, e.g. "isitdry reports".
2. **Extensions → Apps Script**. Replace the code with the contents of `Code.gs` and save.
3. **Deploy → New deployment**. For type, choose **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**, authorise when asked, and copy the **Web app URL** (ends in `/exec`).
5. Paste that URL into `REPORT_URL` in `config.js`, then commit and push.

Until `REPORT_URL` is set, reports are only saved in each reporter's browser, where they can
download them as a CSV.

Each row records what the person found and what the model predicted for that crag, date and
time of day. Those two columns are what we compare to measure accuracy.
