const { S3 } = require('aws-sdk');
const { executeWorkflow, LambdaStep } = require('@cumulus/integration-tests');

const { loadConfig, templateFile, deleteFolder } = require('../helpers/testUtils');

const s3 = new S3();
const config = loadConfig();
const lambdaStep = new LambdaStep();

const taskName = 'DiscoverAndQueuePdrs';
const inputTemplateFilename = './spec/discoverAndQueuePdrs/' +
                              'DiscoverAndQueuePdrs.input.template.json';
const templatedInputFilename = templateFile({
  inputTemplateFilename,
  config: config[taskName]
});

const pdrFilename = 'MOD09GQ_1granule_v3.PDR';

jasmine.DEFAULT_TIMEOUT_INTERVAL = 550000;

describe('The Discover And Queue PDRs workflow', () => {
  let workflowExecution = null;

  beforeAll(async () => {
    await deleteFolder(config.bucket, `${config.stackName}/pdrs`);

    workflowExecution = await executeWorkflow(
      config.stackName,
      config.bucket,
      taskName,
      templatedInputFilename
    );
  });

  it('executes successfully', () => {
    expect(workflowExecution.status).toEqual('SUCCEEDED');
  });

  describe('the DiscoverPdrs Lambda', () => {
    let lambdaOutput = null;

    beforeAll(async () => {
      lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'DiscoverPdrs');
    });

    it('has expected path and name output', () => {
      expect(lambdaOutput.payload.pdrs[0].path).toEqual('cumulus-test-data/pdrs');
      expect(lambdaOutput.payload.pdrs[0].name).toEqual(pdrFilename);
    });
  });

  describe('the QueuePdrs Lambda', () => {
    let lambdaOutput = null;

    beforeAll(async () => {
      lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'QueuePdrs');
    });

    it('output is pdrs_queued', () => {
      expect(lambdaOutput.payload).toEqual({ pdrs_queued: 1 });
    });
  });
});