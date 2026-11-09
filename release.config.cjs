'use strict';

module.exports = {
  branches: ['main'],
  repositoryUrl: 'https://github.com/leozitor/wow-ai-reforged.git',
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    '@semantic-release/changelog',
    ['@semantic-release/npm', { npmPublish: false }],
    './scripts/release-version.cjs',
    ['@semantic-release/git', {
      assets: [
        'CHANGELOG.md', 'package.json', 'package-lock.json',
        'rust/bridge/Cargo.toml', 'Cargo.lock', 'addon/WoWAI/WoWAI.toc',
      ],
      message: 'chore(release): ${nextRelease.version} [skip ci]',
    }],
    ['@semantic-release/github', { successComment: false, failComment: false }],
  ],
};
