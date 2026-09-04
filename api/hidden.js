// Returns 404 for repo-internal paths that zero-config static hosting would
// otherwise serve. Vercel bundles files a function `require`s directly, so
// blocking the PUBLIC URL of /lib/* does not affect the deployed functions --
// they carry their own copy of the code they need.
module.exports = (req, res) => {
    res.status(404).json({ error: 'Not found.' });
};
