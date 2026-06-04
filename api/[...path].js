const { handle } = require('../server/index');

module.exports = async function handler(req, res) {
  return handle(req, res);
};
