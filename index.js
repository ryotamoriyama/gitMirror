'use strict';
const path = require('path');
const childProcess = require('child_process');
const os = require('os');
const {promisify} = require('util');
const fs = require('fs');
const kms = require('@google-cloud/kms');

const tmp = os.tmpdir() + "/gitMirror";

exports.gitMirror = (req, res) => {

    //UAがBitBucketのウェブフックを判定
    if (!req.headers["user-agent"].match(/Bitbucket-Webhooks/)) {
        res.status(403).send("Forbidden");
    }

    //実行ブランチを判定
    const branch = JSON.stringify(req.body.push.changes[0].new.name).replace(/"/g, "");
    if (!branch.match(/^(master|develop)$/)) {
        res.status(200).send("Do Nothing");
    }

    //作業用一時ディレクトリ作成
    const mkTmpDir = childProcess.spawnSync("rm -Rf " + tmp + " && mkdir " + tmp, {shell: true});

    //メイン処理
    create_rsa().then(() => {

        //Bitbucketからクローン
        const bitbucketRepo = childProcess.spawnSync("cd " + tmp + " && git -c core.sshCommand=\"ssh -o 'StrictHostKeyChecking no' -o 'UserKnownHostsFile=/dev/null' -i " + tmp + "/bitbucket_rsa -F /dev/null\" clone --depth=1 " + process.env.BITBUCKET_REPO + " repository", {
            env: process.env,
            stdio: 'pipe',
            encoding: 'utf-8',
            shell: true
        });

        //masterブランチ以外はチェックアウトとプル
        const checkoutBranch = (branch === "master") ? "" : " && git checkout -b " + branch + " && git checkout " + branch + " && git -c core.sshCommand=\"ssh -o 'StrictHostKeyChecking no' -o 'UserKnownHostsFile=/dev/null' -i " + tmp + "/bitbucket_rsa -F /dev/null\" pull origin " + branch;

        //Cloud Source Repositoriesへフォースプッシュ
        const gcsrRepo = childProcess.spawnSync("cd " + tmp + "/repository && git remote add gcsr " + process.env.GCSR_REPO + checkoutBranch + " && git -c core.sshCommand=\"ssh -o 'StrictHostKeyChecking no' -o 'UserKnownHostsFile=/dev/null' -p 2022 -i " + tmp + "/gcsr_rsa -F /dev/null\" push -f gcsr " + branch, {
            env: process.env,
            stdio: 'pipe',
            encoding: 'utf-8',
            shell: true
        });

        //結果
        res.status(200).send(gcsrRepo);
    });
};

//復号する鍵
async function create_rsa() {
    await decrypt_rsa(process.env.BITBUCKET_SECRET_ENC, tmp + "/bitbucket_rsa");
    await decrypt_rsa(process.env.GCSR_SECRET_ENC, tmp + "/gcsr_rsa");
}

//復号
async function decrypt_rsa(enc_text, dec_file) {
    const client = new kms.KeyManagementServiceClient();

    const name = client.cryptoKeyPath(
        process.env.PROJECT_ID,
        'global',
        process.env.KEYRING,
        process.env.KEYNAME
    );

    const ciphertext = enc_text.toString('base64');
    const [result] = await client.decrypt({name, ciphertext});
    const writeFile = promisify(fs.writeFile);
    await writeFile(dec_file, Buffer.from(result.plaintext, 'base64'));
    const modifyPermission = childProcess.spawnSync("chmod 0600 " + dec_file, {shell: true})
}