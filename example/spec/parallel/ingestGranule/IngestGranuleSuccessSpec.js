'use strict';

const fs = require('fs-extra');
const urljoin = require('url-join');
const got = require('got');
const cloneDeep = require('lodash.clonedeep');
const difference = require('lodash.difference');
const includes = require('lodash.includes');
const intersection = require('lodash.intersection');
const {
  models: {
    Execution, Granule, Collection, Provider
  }
} = require('@cumulus/api');
const {
  aws: {
    s3,
    s3GetObjectTagging,
    s3ObjectExists,
    parseS3Uri
  },
  constructCollectionId,
  testUtils: { randomString }
} = require('@cumulus/common');
const {
  api: apiTestUtils,
  buildAndExecuteWorkflow,
  LambdaStep,
  conceptExists,
  getOnlineResources,
  waitForConceptExistsOutcome,
  waitUntilGranuleStatusIs
} = require('@cumulus/integration-tests');

const {
  loadConfig,
  templateFile,
  uploadTestDataToBucket,
  deleteFolder,
  getExecutionUrl,
  createTimestampedTestId,
  createTestDataPath,
  createTestSuffix,
  getFilesMetadata
} = require('../../helpers/testUtils');

const {
  setupTestGranuleForIngest,
  loadFileWithUpdatedGranuleIdPathAndCollection
} = require('../../helpers/granuleUtils');

const { getConfigObject } = require('../../helpers/configUtils');

const config = loadConfig();
const lambdaStep = new LambdaStep();
const workflowName = 'IngestAndPublishGranule';

const workflowConfigFile = './workflows/sips.yml';

const granuleRegex = '^MOD09GQ\\.A[\\d]{7}\\.[\\w]{6}\\.006\\.[\\d]{13}$';

const templatedSyncGranuleFilename = templateFile({
  inputTemplateFilename: './spec/parallel/ingestGranule/SyncGranule.output.payload.template.json',
  config: config[workflowName].SyncGranuleOutput
});

const templatedOutputPayloadFilename = templateFile({
  inputTemplateFilename: './spec/parallel/ingestGranule/IngestGranule.output.payload.template.json',
  config: config[workflowName].IngestGranuleOutput
});

const s3data = [
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606_ndvi.jpg'
];

describe('The S3 Ingest Granules workflow', () => {
  const testId = createTimestampedTestId(config.stackName, 'IngestGranuleSuccess');
  const testSuffix = createTestSuffix(testId);
  const testDataFolder = createTestDataPath(testId);
  const inputPayloadFilename = './spec/parallel/ingestGranule/IngestGranule.input.payload.json';
  const providersDir = './data/providers/s3/';
  const collectionsDir = './data/collections/s3_MOD09GQ_006';
  const collection = { name: `MOD09GQ${testSuffix}`, version: '006' };
  const newCollectionId = constructCollectionId(collection.name, collection.version);
  const provider = { id: `s3_provider${testSuffix}` };
  let workflowExecution = null;
  let failingWorkflowExecution;
  let failedExecutionArn;
  let failedExecutionName;
  let inputPayload;
  let expectedSyncGranulePayload;
  let expectedPayload;
  let expectedS3TagSet;
  let startTime;

  process.env.GranulesTable = `${config.stackName}-GranulesTable`;
  const granuleModel = new Granule();
  process.env.ExecutionsTable = `${config.stackName}-ExecutionsTable`;
  const executionModel = new Execution();
  process.env.CollectionsTable = `${config.stackName}-CollectionsTable`;
  const collectionModel = new Collection();
  process.env.ProvidersTable = `${config.stackName}-ProvidersTable`;
  const providerModel = new Provider();
  let executionName;

  beforeAll(async () => {
    const collectionJson = JSON.parse(fs.readFileSync(`${collectionsDir}/s3_MOD09GQ_006.json`, 'utf8'));
    const collectionData = Object.assign({}, collectionJson, {
      name: collection.name,
      dataType: collectionJson.dataType + testSuffix
    });

    const providerJson = JSON.parse(fs.readFileSync(`${providersDir}/s3_provider.json`, 'utf8'));
    const providerData = Object.assign({}, providerJson, {
      id: provider.id,
      host: config.bucket
    });

    // populate collections, providers and test data
    await Promise.all([
      uploadTestDataToBucket(config.bucket, s3data, testDataFolder),
      apiTestUtils.addCollectionApi({ prefix: config.stackName, collection: collectionData }),
      apiTestUtils.addProviderApi({ prefix: config.stackName, provider: providerData })
    ]);

    const inputPayloadJson = fs.readFileSync(inputPayloadFilename, 'utf8');
    // update test data filepaths
    inputPayload = await setupTestGranuleForIngest(config.bucket, inputPayloadJson, granuleRegex, testSuffix, testDataFolder);
    const granuleId = inputPayload.granules[0].granuleId;
    expectedS3TagSet = [{ Key: 'granuleId', Value: granuleId }];
    await Promise.all(inputPayload.granules[0].files.map((fileToTag) =>
      s3().putObjectTagging({ Bucket: config.bucket, Key: `${fileToTag.path}/${fileToTag.name}`, Tagging: { TagSet: expectedS3TagSet } }).promise()));

    expectedSyncGranulePayload = loadFileWithUpdatedGranuleIdPathAndCollection(templatedSyncGranuleFilename, granuleId, testDataFolder, newCollectionId);
    expectedSyncGranulePayload.granules[0].dataType += testSuffix;
    expectedPayload = loadFileWithUpdatedGranuleIdPathAndCollection(templatedOutputPayloadFilename, granuleId, testDataFolder, newCollectionId);
    expectedPayload.granules[0].dataType += testSuffix;

    // pre-stage destination files for MoveGranules
    const preStageFiles = expectedPayload.granules[0].files.map((file) => {
      // CMR file will be skipped by MoveGranules, so no need to stage it
      if (file.filename.slice(-8) === '.cmr.xml') {
        return Promise.resolve();
      }
      const params = {
        Bucket: file.bucket,
        Key: file.filepath,
        Body: randomString()
      };
      // expect duplicates to be reported
      // eslint-disable-next-line no-param-reassign
      file.duplicate_found = true;
      return s3().putObject(params).promise();
    });
    await Promise.all(preStageFiles);
    startTime = new Date();

    workflowExecution = await buildAndExecuteWorkflow(
      config.stackName,
      config.bucket,
      workflowName,
      collection,
      provider,
      inputPayload
    );

    failingWorkflowExecution = await buildAndExecuteWorkflow(
      config.stackName,
      config.bucket,
      workflowName,
      collection,
      provider,
      {}
    );
    failedExecutionArn = failingWorkflowExecution.executionArn.split(':');
    failedExecutionName = failedExecutionArn.pop();
  });

  afterAll(async () => {
    // clean up stack state added by test
    await Promise.all([
      deleteFolder(config.bucket, testDataFolder),
      collectionModel.delete(collection),
      providerModel.delete(provider),
      executionModel.delete({ arn: workflowExecution.executionArn }),
      executionModel.delete({ arn: failingWorkflowExecution.executionArn }),
      s3().deleteObject({ Bucket: config.bucket, Key: `${config.stackName}/test-output/${executionName}.output` }).promise(),
      s3().deleteObject({ Bucket: config.bucket, Key: `${config.stackName}/test-output/${failedExecutionName}.output` }).promise(),
      apiTestUtils.deleteGranule({
        prefix: config.stackName,
        granuleId: inputPayload.granules[0].granuleId
      })
    ]);
  });

  it('completes execution with success status', () => {
    expect(workflowExecution.status).toEqual('SUCCEEDED');
  });

  it('can retrieve the specific provider that was created', async () => {
    const providerListResponse = await apiTestUtils.getProviders({ prefix: config.stackName });
    const providerList = JSON.parse(providerListResponse.body);
    expect(providerList.results.length).toBeGreaterThan(0);

    const providerResultResponse = await apiTestUtils.getProvider({ prefix: config.stackName, providerId: provider.id });
    const providerResult = JSON.parse(providerResultResponse.body);
    expect(providerResult).not.toBeNull();
  });

  it('can retrieve the specific collection that was created', async () => {
    const collectionListResponse = await apiTestUtils.getCollections({ prefix: config.stackName });
    const collectionList = JSON.parse(collectionListResponse.body);
    expect(collectionList.results.length).toBeGreaterThan(0);

    const collectionResponse = await apiTestUtils.getCollection(
      { prefix: config.stackName, collectionName: collection.name, collectionVersion: collection.version }
    );
    const collectionResult = JSON.parse(collectionResponse.body);
    expect(collectionResult).not.toBeNull();
  });

  it('makes the granule available through the Cumulus API', async () => {
    const granuleResponse = await apiTestUtils.getGranule({
      prefix: config.stackName,
      granuleId: inputPayload.granules[0].granuleId
    });
    const granule = JSON.parse(granuleResponse.body);

    expect(granule.granuleId).toEqual(inputPayload.granules[0].granuleId);
  });

  describe('the SyncGranules task', () => {
    let lambdaInput;
    let lambdaOutput;

    beforeAll(async () => {
      lambdaInput = await lambdaStep.getStepInput(workflowExecution.executionArn, 'SyncGranule');
      lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'SyncGranule');
    });

    it('receives the correct collection and provider configuration', () => {
      expect(lambdaInput.meta.collection.name).toEqual(collection.name);
      expect(lambdaInput.meta.provider.id).toEqual(provider.id);
    });

    it('output includes the ingested granule with file staging location paths', () => {
      expect(lambdaOutput.payload).toEqual(expectedSyncGranulePayload);
    });

    it('updates the meta object with input_granules', () => {
      expect(lambdaOutput.meta.input_granules).toEqual(expectedSyncGranulePayload.granules);
    });
  });

  describe('the MoveGranules task', () => {
    let lambdaOutput;
    let files;
    let movedTaggings;
    const existCheck = [];

    beforeAll(async () => {
      lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'MoveGranules');
      files = lambdaOutput.payload.granules[0].files;
      movedTaggings = await Promise.all(lambdaOutput.payload.granules[0].files.map((file) => {
        const { Bucket, Key } = parseS3Uri(file.filename);
        return s3GetObjectTagging(Bucket, Key);
      }));
      existCheck[0] = await s3ObjectExists({ Bucket: files[0].bucket, Key: files[0].filepath });
      existCheck[1] = await s3ObjectExists({ Bucket: files[1].bucket, Key: files[1].filepath });
      existCheck[2] = await s3ObjectExists({ Bucket: files[2].bucket, Key: files[2].filepath });
    });

    afterAll(async () => {
      await Promise.all([
        s3().deleteObject({ Bucket: files[0].bucket, Key: files[0].filepath }).promise(),
        s3().deleteObject({ Bucket: files[1].bucket, Key: files[1].filepath }).promise(),
        s3().deleteObject({ Bucket: files[3].bucket, Key: files[3].filepath }).promise()
      ]);
    });

    it('has a payload with correct buckets, filenames, filesizes, and duplicate reporting', () => {
      files.forEach((file) => {
        const expectedFile = expectedPayload.granules[0].files.find((f) => f.name === file.name);
        expect(file.filename).toEqual(expectedFile.filename);
        expect(file.bucket).toEqual(expectedFile.bucket);
        expect(file.duplicate_found).toBe(expectedFile.duplicate_found);
        if (file.fileSize) {
          expect(file.fileSize).toEqual(expectedFile.fileSize);
        }
      });
    });

    it('moves files to the bucket folder based on metadata', () => {
      existCheck.forEach((check) => {
        expect(check).toEqual(true);
      });
    });

    it('preserves tags on moved files', () => {
      movedTaggings.forEach((tagging) => {
        expect(tagging.TagSet).toEqual(expectedS3TagSet);
      });
    });

    describe('encounters duplicate filenames', () => {
      it('overwrites the existing file with the new data', async () => {
        const currentFiles = await getFilesMetadata(files);

        currentFiles.forEach((cf) => {
          expect(cf.LastModified).toBeGreaterThan(startTime);
        });
      });
    });
  });

  describe('the PostToCmr task', () => {
    let lambdaOutput;
    let cmrResource;
    let cmrLink;
    let response;
    let files;

    beforeAll(async () => {
      lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'PostToCmr');
      if (lambdaOutput === null) throw new Error(`Failed to get the PostToCmr step's output for ${workflowExecution.executionArn}`);

      files = lambdaOutput.payload.granules[0].files;
      cmrLink = lambdaOutput.payload.granules[0].cmrLink;
      cmrResource = await getOnlineResources(cmrLink);
      response = await got(cmrResource[1].href);
    });

    afterAll(async () => {
      await s3().deleteObject({ Bucket: files[2].bucket, Key: files[2].filepath }).promise();
    });

    it('has expected payload', () => {
      const granule = lambdaOutput.payload.granules[0];
      expect(granule.published).toBe(true);
      expect(granule.cmrLink.startsWith('https://cmr.uat.earthdata.nasa.gov/search/granules.json?concept_id=')).toBe(true);

      // Set the expected cmrLink to the actual cmrLink, since it's going to
      // be different every time this is run.
      const updatedExpectedpayload = cloneDeep(expectedPayload);
      updatedExpectedpayload.granules[0].cmrLink = lambdaOutput.payload.granules[0].cmrLink;

      expect(lambdaOutput.payload).toEqual(updatedExpectedpayload);
    });

    it('publishes the granule metadata to CMR', () => {
      const granule = lambdaOutput.payload.granules[0];
      const result = conceptExists(granule.cmrLink);

      expect(granule.published).toEqual(true);
      expect(result).not.toEqual(false);
    });

    it('updates the CMR metadata online resources with the final metadata location', () => {
      const distEndpoint = config.DISTRIBUTION_ENDPOINT;
      const extension1 = urljoin(files[0].bucket, files[0].filepath);
      const filename = `https://${files[2].bucket}.s3.amazonaws.com/${files[2].filepath}`;

      expect(cmrResource[0].href).toEqual(urljoin(distEndpoint, extension1));
      expect(cmrResource[1].href).toEqual(filename);

      expect(response.statusCode).toEqual(200);
    });
  });

  describe('an SNS message', () => {
    let lambdaOutput;
    const existCheck = [];

    beforeAll(async () => {
      lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'PostToCmr');
      executionName = lambdaOutput.cumulus_meta.execution_name;
      existCheck[0] = await s3ObjectExists({ Bucket: config.bucket, Key: `${config.stackName}/test-output/${executionName}.output` });
      existCheck[1] = await s3ObjectExists({ Bucket: config.bucket, Key: `${config.stackName}/test-output/${failedExecutionName}.output` });
    });

    it('is published on a successful workflow completion', () => {
      expect(existCheck[0]).toEqual(true);
    });

    it('is published on workflow failure', () => {
      expect(existCheck[1]).toEqual(true);
    });

    it('triggers the granule record being added to DynamoDB', async () => {
      const record = await granuleModel.get({ granuleId: inputPayload.granules[0].granuleId });
      expect(record.execution).toEqual(getExecutionUrl(workflowExecution.executionArn));
    });

    it('triggers the execution record being added to DynamoDB', async () => {
      const record = await executionModel.get({ arn: workflowExecution.executionArn });
      expect(record.status).toEqual('completed');
    });
  });

  describe('The Cumulus API', () => {
    let workflowConfig;
    beforeAll(() => {
      workflowConfig = getConfigObject(workflowConfigFile, workflowName);
    });

    describe('granule endpoint', () => {
      let granule;
      let cmrLink;

      beforeAll(async () => {
        const granuleResponse = await apiTestUtils.getGranule({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId
        });
        granule = JSON.parse(granuleResponse.body);
        cmrLink = granule.cmrLink;
      });

      it('makes the granule available through the Cumulus API', async () => {
        expect(granule.granuleId).toEqual(inputPayload.granules[0].granuleId);
      });

      it('has the granule with a CMR link', () => {
        expect(granule.cmrLink).not.toBeUndefined();
      });

      it('allows reingest and executes with success status', async () => {
        const oldUpdatedAt = granule.updatedAt;
        const oldExecution = granule.execution;

        // Reingest Granule and compare the updatedAt times
        const reingestGranuleResponse = await apiTestUtils.reingestGranule({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId
        });
        const reingestResponse = JSON.parse(reingestGranuleResponse.body);
        expect(reingestResponse.status).toEqual('SUCCESS');

        const secondGranuleResponse = await apiTestUtils.getGranule({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId
        });
        const secondGranule = JSON.parse(secondGranuleResponse.body);
        expect(secondGranule.updatedAt).toBeGreaterThan(oldUpdatedAt);

        // Await reingest completion
        await waitUntilGranuleStatusIs(config.stackName, inputPayload.granules[0].granuleId, 'completed');
        const updatedGranuleResponse = await apiTestUtils.getGranule({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId
        });
        const updatedGranule = JSON.parse(updatedGranuleResponse.body);
        expect(updatedGranule.status).toEqual('completed');
        expect(updatedGranule.execution).not.toEqual(oldExecution);
      });

      it('removeFromCMR removes the ingested granule from CMR', async () => {
        const existsInCMR = await conceptExists(cmrLink);

        expect(existsInCMR).toEqual(true);

        // Remove the granule from CMR
        await apiTestUtils.removeFromCMR({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId
        });

        // Check that the granule was removed
        await waitForConceptExistsOutcome(cmrLink, false);
        const doesExist = await conceptExists(cmrLink);
        expect(doesExist).toEqual(false);
      });

      it('applyWorkflow PublishGranule publishes the granule to CMR', async () => {
        const existsInCMR = await conceptExists(cmrLink);
        expect(existsInCMR).toEqual(false);

        // Publish the granule to CMR
        await apiTestUtils.applyWorkflow({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId,
          workflow: 'PublishGranule'
        });

        await waitForConceptExistsOutcome(cmrLink, true);
        const doesExist = await conceptExists(cmrLink);
        expect(doesExist).toEqual(true);
      });

      it('can delete the ingested granule from the API', async () => {
        // pre-delete: Remove the granule from CMR
        const removeFromCmrResponse = await apiTestUtils.removeFromCMR({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId
        });

        console.log(`remove from cmr response: ${JSON.stringify(removeFromCmrResponse)}`);

        // Delete the granule
        const deleteResponse = await apiTestUtils.deleteGranule({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId
        });

        console.log(`delete granule response: ${JSON.stringify(deleteResponse)}`);

        // Verify deletion
        const granuleResponse = await apiTestUtils.getGranule({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId
        });
        const resp = JSON.parse(granuleResponse.body);
        console.log(JSON.stringify(granuleResponse));
        expect(resp.message).toEqual('Granule not found');
      });
    });

    describe('executions endpoint', () => {
      let executionResponse;

      beforeAll(async () => {
        const executionApiResponse = await apiTestUtils.getExecution({
          prefix: config.stackName,
          arn: workflowExecution.executionArn
        });
        executionResponse = JSON.parse(executionApiResponse.body);
      });

      it('returns overall status and timing for the execution', async () => {
        expect(executionResponse.status).toBeDefined();
        expect(executionResponse.createdAt).toBeDefined();
        expect(executionResponse.updatedAt).toBeDefined();
        expect(executionResponse.duration).toBeDefined();
      });

      it('returns tasks metadata with name and version', async () => {
        expect(executionResponse.tasks).toBeDefined();
        expect(executionResponse.tasks.length).not.toEqual(0);
        Object.keys(executionResponse.tasks).forEach((step) => {
          const task = executionResponse.tasks[step];
          expect(task.name).toBeDefined();
          expect(task.version).toBeDefined();
        });
      });
    });

    describe('When accessing a workflow execution via the API', () => {
      let executionStatus;
      let allStates;

      beforeAll(async () => {
        const executionArn = workflowExecution.executionArn;
        const executionStatusResponse = await apiTestUtils.getExecutionStatus({
          prefix: config.stackName,
          arn: executionArn
        });
        executionStatus = JSON.parse(executionStatusResponse.body);

        allStates = Object.keys(workflowConfig.States);
      });

      it('returns the inputs and outputs for the entire workflow', async () => {
        expect(executionStatus.execution).toBeTruthy();
        expect(executionStatus.execution.executionArn).toEqual(workflowExecution.executionArn);
        const input = JSON.parse(executionStatus.execution.input);
        const output = JSON.parse(executionStatus.execution.output);
        expect(input.payload).toEqual(inputPayload);
        expect(output.payload || output.replace).toBeTruthy();
      });

      it('returns the stateMachine information and workflow definition', async () => {
        expect(executionStatus.stateMachine).toBeTruthy();
        expect(executionStatus.stateMachine.stateMachineArn).toEqual(executionStatus.execution.stateMachineArn);
        expect(executionStatus.stateMachine.stateMachineArn.endsWith(executionStatus.stateMachine.name)).toBe(true);

        const definition = JSON.parse(executionStatus.stateMachine.definition);
        expect(definition.Comment).toEqual('Ingest Granule');
        const stateNames = Object.keys(definition.States);

        // definition has all the states' information
        expect(difference(allStates, stateNames).length).toBe(0);
      });

      it('returns the inputs, outputs, timing, and status information for each executed step', async () => {
        expect(executionStatus.executionHistory).toBeTruthy();

        // expected 'not executed' steps
        const expectedNotExecutedSteps = ['SyncGranule', 'WorkflowFailed'];

        // expected 'executed' steps
        const expectedExecutedSteps = difference(allStates, expectedNotExecutedSteps);

        // steps with *EventDetails will have the input/output, and also stepname when state is entered/exited
        const stepNames = [];
        executionStatus.executionHistory.events.forEach((event) => {
          // expect timing information for each step
          expect(event.timestamp).toBeDefined();
          const eventKeys = Object.keys(event);
          // protect against "undefined": TaskStateEntered has "input" but not "name"
          if (event.name && intersection(eventKeys, ['input', 'output']).length === 1) {
            // each step should contain status information
            if (event.type === 'TaskStateExited') {
              const prevEvent = executionStatus.executionHistory.events[event.previousEventId - 1];
              expect(['LambdaFunctionSucceeded', 'LambdaFunctionFailed']).toContain(prevEvent.type);
            }
            if (!includes(stepNames, event.name)) stepNames.push(event.name);
          }
        });

        // all the executed steps have *EventDetails
        expect(difference(expectedExecutedSteps, stepNames).length).toBe(0);
        // some steps are not executed
        expect(difference(expectedNotExecutedSteps, stepNames).length).toBe(expectedNotExecutedSteps.length);
      });
    });

    describe('logs endpoint', () => {
      it('returns logs with a specific execution name', async () => {
        const executionARNTokens = workflowExecution.executionArn.split(':');
        const logsExecutionName = executionARNTokens[executionARNTokens.length - 1];
        const logsResponse = await apiTestUtils.getExecutionLogs({ prefix: config.stackName, executionName: logsExecutionName });
        const logs = JSON.parse(logsResponse.body);
        expect(logs.meta.count).not.toEqual(0);
        logs.results.forEach((log) => {
          expect(log.sender).not.toBe(undefined);
          expect(log.executions).toEqual(logsExecutionName);
        });
      });
    });

    describe('workflows endpoint', () => {
      it('returns a list of workflows', async () => {
        const workflowsResponse = await apiTestUtils.getWorkflows({ prefix: config.stackName });

        const workflows = JSON.parse(workflowsResponse.body);
        expect(workflows).not.toBe(undefined);
        expect(workflows.length).toBeGreaterThan(0);
      });

      it('returns the expected workflow', async () => {
        const workflowResponse = await apiTestUtils.getWorkflow({
          prefix: config.stackName,
          workflowName: workflowName
        });
        const foundWorkflow = JSON.parse(workflowResponse.body);
        const foundKeys = Object.keys(foundWorkflow.definition.States);
        const configKeys = Object.keys(workflowConfig.States);
        expect(foundWorkflow.definition.Comment).toEqual(workflowConfig.Comment);
        expect(foundKeys).toEqual(configKeys);
      });
    });
  });
});
