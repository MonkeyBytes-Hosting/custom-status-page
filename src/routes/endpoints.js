'use strict';

const { Router } = require('express');
const path = require('path');

const router = Router();

router.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, '../views/endpoints.html'))
);

module.exports = router;
