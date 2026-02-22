module.exports = {
    env: {
        node: true,
        browser: true,
        es2022: true,
        jest: true
    },
    extends: 'eslint:recommended',
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
    },
    rules: {
        'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
        'no-console': 'off',
        'indent': ['warn', 4],
        'quotes': ['warn', 'single'],
        'semi': ['warn', 'always'],
        'no-trailing-spaces': 'warn',
        'no-multiple-empty-lines': ['warn', { max: 2 }],
        'comma-dangle': ['warn', 'never'],
        'space-before-function-paren': ['warn', 'always'],
        'keyword-spacing': 'warn',
        'key-spacing': 'warn',
        'no-empty': 'warn'
    },
    ignorePatterns: [
        'node_modules/',
        'dist/',
        'build/',
        'coverage/',
        '*.min.js'
    ]
};
