import { createStore, combineReducers, applyMiddleware } from 'redux';
import { Provider } from 'react-redux';
import { Switch } from 'react-router-dom';
import { createBrowserHistory } from 'history';
import { Route } from 'react-router';
import { ConnectedRouter, routerMiddleware } from 'react-router-redux';

// Reducers/actions
import { reducer as apiHealth } from './api-health';

// Components
import NotFoundPage from './components/not-found-page';
import ErrorPage from './components/error-page';
import LandingPage from './components/landing-page';

const React = require('react');
const ReactDOM = require('react-dom');

// Create a history of your choosing (we're using a browser history in this case)
const history = createBrowserHistory();

// This looks for hash options and changes it to a regular url.
// Based on some solutions described here:
// http://stackoverflow.com/questions/16267339/s3-static-website-hosting-route-all-paths-to-index-html
function convertHistoryHash(location) {
  // Check if the location hash is something like "#/foo" then we get just the "/foo" part
  const path = (/#(\/.*)$/.exec(location.hash) || [])[1];
  if (path) {
    history.replace(path);
  }
}
history.listen(convertHistoryHash);
// Fix the current load if necessary.
convertHistoryHash(history.location);

// Build the middleware for intercepting and dispatching navigation actions
const middleware = routerMiddleware(history);

const reducers = combineReducers({
  apiHealth,
});
const store = createStore(reducers, applyMiddleware(middleware));

ReactDOM.render(
  <Provider store={store}>
    { /* Tell the Router to use our enhanced history */ }
    <ConnectedRouter history={history}>
      <Switch>
        <Route exact path="/" component={LandingPage} />
        <Route path="/error" component={ErrorPage} />
        <Route component={NotFoundPage} />
      </Switch>
    </ConnectedRouter>
  </Provider>,
  document.getElementById('mount'),
);
